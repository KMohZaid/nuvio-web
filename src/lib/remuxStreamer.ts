import { buildInitSegment, buildMediaSegment, type MuxTrack } from "./fmp4";
import { MatroskaStream, type StreamFrame } from "./matroskaStream";
import { describeTrack } from "./remux";
import type { TrackHeader } from "./matroskaBlocks";

/**
 * Streams an MKV into a media element by remuxing it on the fly.
 *
 * Fetches ranges ahead of the playhead, feeds them to the resumable demuxer,
 * batches the frames it emits into fMP4 fragments, and appends those to a
 * SourceBuffer — evicting behind so the buffer stays inside its quota.
 *
 * Nothing here decodes. The cost is one HTTP request per chunk plus the byte
 * shuffling, which is why this runs on a phone at all.
 */

const CHUNK_BYTES = 1024 * 1024;
/** How far ahead of the playhead to stay. */
const TARGET_AHEAD_SECONDS = 30;
/** How much history to keep before evicting; MSE throws when the quota goes. */
const KEEP_BEHIND_SECONDS = 20;
/** Frames are batched into fragments of about this length. */
const FRAGMENT_SECONDS = 2;

export type StreamerStatus = {
  state: "idle" | "starting" | "buffering" | "ready" | "ended" | "error";
  message: string;
  bufferedSeconds?: number;
  fetchedBytes?: number;
};

export class RemuxStreamer {
  private demuxer = new MatroskaStream();
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private pending = new Map<number, StreamFrame[]>();
  private muxTracks = new Map<number, MuxTrack>();
  private sequence = 1;
  private nextByte = 0;
  private totalBytes: number | null = null;
  private resolvedUrl = "";
  private stopped = false;
  private fetching = false;

  constructor(
    private readonly url: string,
    private readonly element: HTMLVideoElement,
    private readonly onStatus: (status: StreamerStatus) => void,
  ) {}

  stop() {
    this.stopped = true;
    this.queue = [];
    try {
      if (this.source?.readyState === "open") this.source.endOfStream();
    } catch {
      // Already torn down.
    }
  }

  async start() {
    this.onStatus({ state: "starting", message: "Resolving source…" });
    try {
      // One resolution up front: debrid links redirect, and the Range header
      // does not survive the hop.
      const head = await fetch(this.url, {
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
      });
      this.resolvedUrl = head.url || this.url;
      const range = head.headers.get("content-range");
      const total = range?.split("/")?.[1];
      this.totalBytes = total && total !== "*" ? Number(total) : null;
      await head.body?.cancel().catch(() => undefined);
    } catch (error) {
      this.onStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Could not reach the source.",
      });
      return;
    }

    // Read until the demuxer has the track headers, which is what the init
    // segment is built from.
    while (!this.demuxer.headerComplete && !this.stopped) {
      const chunk = await this.fetchNext();
      if (!chunk) break;
      this.absorb(this.demuxer.push(chunk));
    }
    if (this.stopped) return;
    if (!this.demuxer.headerComplete) {
      this.onStatus({ state: "error", message: "No track headers found." });
      return;
    }

    const tracks = this.chooseTracks();
    if (!tracks.length) {
      this.onStatus({
        state: "error",
        message: "No track in this file can be remuxed here.",
      });
      return;
    }

    const mime = `video/mp4; codecs="${tracks.map(codecString).join(",")}"`;
    const Source =
      (window as unknown as { ManagedMediaSource?: typeof MediaSource })
        .ManagedMediaSource ?? window.MediaSource;
    if (!Source?.isTypeSupported(mime)) {
      this.onStatus({ state: "error", message: `Browser rejects ${mime}.` });
      return;
    }

    const source = new Source();
    this.source = source as MediaSource;
    this.element.disableRemotePlayback = true;
    this.element.src = URL.createObjectURL(source as unknown as MediaSource);

    await new Promise<void>((resolve) =>
      source.addEventListener("sourceopen", () => resolve(), { once: true }),
    );
    if (this.stopped) return;

    try {
      const buffer = (source as MediaSource).addSourceBuffer(mime);
      this.buffer = buffer;
      buffer.addEventListener("updateend", () => this.pump());
      buffer.addEventListener("error", () =>
        this.onStatus({ state: "error", message: "SourceBuffer rejected a segment." }),
      );
      if (this.demuxer.durationSeconds)
        (source as MediaSource).duration = this.demuxer.durationSeconds;
      this.enqueue(buildInitSegment(tracks));
    } catch (error) {
      this.onStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Could not open a buffer.",
      });
      return;
    }

    void this.loop();
  }

  /** Keeps fetching while the buffer runs short of the playhead. */
  private async loop() {
    while (!this.stopped) {
      const ahead = this.bufferedAhead();
      if (ahead > TARGET_AHEAD_SECONDS || this.fetching) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        this.evict();
        continue;
      }
      const chunk = await this.fetchNext();
      if (!chunk) {
        this.flush(true);
        this.onStatus({
          state: "ended",
          message: "Reached the end of the file.",
          bufferedSeconds: this.bufferedAhead(),
        });
        return;
      }
      this.absorb(this.demuxer.push(chunk));
      this.flush(false);
      this.onStatus({
        state: this.bufferedAhead() > 1 ? "ready" : "buffering",
        message: `Streaming · ${(this.nextByte / 1024 / 1024).toFixed(1)} MB read`,
        bufferedSeconds: this.bufferedAhead(),
        fetchedBytes: this.nextByte,
      });
    }
  }

  private async fetchNext(): Promise<Uint8Array | null> {
    if (this.totalBytes != null && this.nextByte >= this.totalBytes) return null;
    this.fetching = true;
    try {
      const end = this.nextByte + CHUNK_BYTES - 1;
      const response = await fetch(this.resolvedUrl || this.url, {
        headers: { Range: `bytes=${this.nextByte}-${end}` },
        cache: "no-store",
      });
      if (!response.ok && response.status !== 206) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return null;
      this.nextByte += bytes.byteLength;
      return bytes;
    } catch {
      return null;
    } finally {
      this.fetching = false;
    }
  }

  private absorb(frames: StreamFrame[]) {
    for (const frame of frames) {
      const list = this.pending.get(frame.track) ?? [];
      list.push(frame);
      this.pending.set(frame.track, list);
    }
  }

  private chooseTracks(): MuxTrack[] {
    const wanted: MuxTrack[] = [];
    const video = this.demuxer.tracks.find((track) => track.kind === "video");
    // Prefer an audio track whose config can actually be built, which skips
    // TrueHD in favour of the E-AC-3 alongside it.
    const audio = this.demuxer.tracks
      .filter((track) => track.kind === "audio")
      .map((track) => ({ track, first: this.pending.get(track.number)?.[0] }))
      .map(({ track, first }) =>
        describeTrack(
          asHeader(track),
          undefined,
          undefined,
          track.channels,
          first?.data,
        ),
      )
      .find((described) => !("reason" in described));

    if (video) {
      const described = describeTrack(
        asHeader(video),
        video.width,
        video.height,
      );
      if (!("reason" in described)) wanted.push(described);
    }
    if (audio && !("reason" in audio)) wanted.push(audio);
    for (const track of wanted) this.muxTracks.set(track.id, track);
    return wanted;
  }

  /**
   * Emits fragments for whatever is ready.
   *
   * The last frame of each track is held back: its duration is the gap to the
   * frame after it, which has not arrived yet. Guessing instead produces a
   * fragment whose length disagrees with the next one, and the gap shows up as
   * a stall at every fragment boundary.
   */
  private flush(final: boolean) {
    for (const [trackNumber, frames] of this.pending) {
      const track = this.muxTracks.get(trackNumber);
      if (!track || frames.length < 2) continue;
      const usable = final ? frames : frames.slice(0, -1);
      const span = usable.at(-1)!.timeMs - usable[0]!.timeMs;
      if (!final && span < FRAGMENT_SECONDS * 1000) continue;

      const samples = usable.map((frame, index) => {
        const next = usable[index + 1] ?? frames[index + 1];
        const previous = usable[index - 1];
        const duration = next
          ? next.timeMs - frame.timeMs
          : previous
            ? frame.timeMs - previous.timeMs
            : 40;
        return {
          data: frame.data,
          durationTicks: Math.max(1, Math.round(duration)),
          keyframe: frame.keyframe,
        };
      });
      this.enqueue(
        buildMediaSegment(
          this.sequence++,
          trackNumber,
          Math.round(usable[0]!.timeMs),
          samples,
        ),
      );
      this.pending.set(trackNumber, final ? [] : frames.slice(usable.length));
    }
  }

  private enqueue(segment: Uint8Array) {
    this.queue.push(segment);
    this.pump();
  }

  /** Appends serially: a SourceBuffer rejects overlapping updates. */
  private pump() {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || this.stopped) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      buffer.appendBuffer(next as unknown as BufferSource);
    } catch (error) {
      // A quota error means eviction has to happen before this can retry.
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        this.queue.unshift(next);
        this.evict(true);
        return;
      }
      this.onStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Append failed.",
      });
    }
  }

  private bufferedAhead() {
    const buffer = this.buffer;
    if (!buffer?.buffered.length) return 0;
    const time = this.element.currentTime;
    for (let index = 0; index < buffer.buffered.length; index += 1)
      if (time >= buffer.buffered.start(index) - 0.5 && time <= buffer.buffered.end(index))
        return buffer.buffered.end(index) - time;
    return 0;
  }

  private evict(aggressive = false) {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || !buffer.buffered.length) return;
    const keep = aggressive ? 5 : KEEP_BEHIND_SECONDS;
    const cutoff = this.element.currentTime - keep;
    if (cutoff <= buffer.buffered.start(0)) return;
    try {
      buffer.remove(buffer.buffered.start(0), cutoff);
    } catch {
      // Removal is best effort; the next pass will try again.
    }
  }
}

/** The streaming demuxer and the scanner describe tracks slightly differently. */
function asHeader(track: {
  number: number;
  kind: string;
  codecId: string;
  codecPrivate: Uint8Array | null;
}): TrackHeader {
  return {
    number: track.number,
    kind: track.kind as TrackHeader["kind"],
    codecId: track.codecId,
    codecPrivate: track.codecPrivate,
    defaultDurationNs: null,
  };
}

function codecString(track: MuxTrack) {
  switch (track.sampleEntry) {
    case "av01":
      return "av01.0.08M.10";
    case "hvc1":
      return "hvc1.1.6.L93.B0";
    case "avc1":
      return "avc1.640028";
    case "ec-3":
      return "ec-3";
    case "ac-3":
      return "ac-3";
    default:
      return "mp4a.40.2";
  }
}
