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

/**
 * 8 MB, not 1 MB. A 4K stream runs at tens of megabits, so small chunks mean
 * hundreds of sequential requests per minute — which debrid hosts rate limit,
 * and which shows up as a generic network failure part way in.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** A refused range is usually transient: back off and try again. */
const FETCH_ATTEMPTS = 3;
/**
 * Buffer targets are in bytes, not seconds.
 *
 * Thirty seconds means something completely different at 4 Mbps and at 60:
 * for a 4K stream it is roughly 200 MB resident in the SourceBuffer, which is
 * far past what iOS allows and shows up as unrelated-looking network failures
 * once the tab is under memory pressure. So the time target is derived from an
 * observed bitrate against a byte budget.
 */
const BUFFER_BUDGET_BYTES = 40 * 1024 * 1024;
const MAX_AHEAD_SECONDS = 30;
const MIN_AHEAD_SECONDS = 6;
/** How much history to keep before evicting; MSE throws when the quota goes. */
const KEEP_BEHIND_SECONDS = 6;
/** Frames are batched into fragments of about this length. */
const FRAGMENT_SECONDS = 2;

export type StreamerStatus = {
  state: "idle" | "starting" | "buffering" | "ready" | "ended" | "error";
  message: string;
  bufferedSeconds?: number;
  fetchedBytes?: number;
  /** Rendered verbatim: a gap between ranges is the thing to look for. */
  ranges?: string;
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
  /** Bytes read while the buffer failed to grow, which means something is wrong. */
  private bytesSinceProgress = 0;
  private lastBufferedEnd = 0;
  /** Bytes appended and seconds they represent, for the bitrate estimate. */
  private appendedBytes = 0;
  private appendedSeconds = 0;
  /** Last thing the element said about itself, so "won't play" has a reason. */
  private mediaNote = "";
  private triedPlay = false;

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
      const parsed = total && total !== "*" ? Number(total) : NaN;
      // A bad or absent total is worse than none: it ends the stream early.
      // Treat anything implausible as unknown and let the reads decide.
      this.totalBytes =
        Number.isFinite(parsed) && parsed > CHUNK_BYTES ? parsed : null;
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
    // Read past the headers into the first cluster: choosing an audio track
    // needs a frame in hand, because AC-3 config is read from the bitstream.
    let primed = 0;
    while (!this.stopped && (!this.demuxer.headerComplete || primed < 2)) {
      const chunk = await this.fetchNext();
      if ("done" in chunk) break;
      this.absorb(this.demuxer.push(chunk.bytes));
      if (this.demuxer.headerComplete) primed += 1;
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
    this.watchElement();
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

  /**
   * Records what the element is doing.
   *
   * "It won't play" covers a decode failure, a stall waiting for data and a
   * blocked autoplay, which need different answers. The element knows which;
   * it just has no way to say so unless someone is listening.
   */
  private watchElement() {
    const note = (text: string) => {
      this.mediaNote = text;
    };
    for (const event of ["waiting", "stalled", "playing", "pause", "seeking"])
      this.element.addEventListener(event, () => note(event));
    this.element.addEventListener("error", () => {
      const error = this.element.error;
      note(`element error ${error?.code ?? "?"}: ${error?.message || "no detail"}`);
      this.onStatus({
        state: "error",
        message: `The video element rejected the stream — ${error?.message || `code ${error?.code}`}.`,
        ranges: this.describeRanges(),
        fetchedBytes: this.nextByte,
      });
    });
  }

  /**
   * Starts playback once there is something to play. The Stream button is a
   * user gesture, but it is spent by the time the first fragment lands, so a
   * refusal here is expected on iOS and is reported rather than treated as a
   * failure.
   */
  private tryPlay() {
    if (this.triedPlay || this.bufferedAhead() < 1) return;
    this.triedPlay = true;
    void this.element.play().catch((error: unknown) => {
      this.mediaNote =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "autoplay blocked — press play"
          : `play() refused: ${error instanceof Error ? error.message : "unknown"}`;
    });
  }

  /** Keeps fetching while the buffer runs short of the playhead. */
  private async loop() {
    try {
      await this.pump0();
    } catch (error) {
      this.onStatus({
        state: "error",
        message: `Streaming stopped: ${error instanceof Error ? error.message : "unknown"}.`,
      });
    }
  }

  private async pump0() {
    while (!this.stopped) {
      const ahead = this.bufferedAhead();
      // Resident bytes throttle independently of the time measure. If the
      // playhead sits outside every buffered range, bufferedAhead reports zero
      // and the time check never holds it back — which is how a stalled
      // player ends up downloading hundreds of megabytes until the host
      // refuses to serve any more.
      //
      // The budget never applies below the minimum, though. Eviction can only
      // free what is behind the playhead, so a budget smaller than the minimum
      // costs deadlocks: holding at four seconds with the playhead at zero,
      // nothing old enough to evict, and no way back under.
      const overBudget =
        ahead >= MIN_AHEAD_SECONDS && this.appendedBytes > this.budgetBytes();
      if (ahead > this.targetAhead() || overBudget || this.fetching) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        this.evict();
        this.tryPlay();
        this.onStatus({
          state: "ready",
          message: `Holding · ${(this.nextByte / 1024 / 1024).toFixed(0)} MB read · target ${this.targetAhead().toFixed(0)}s · resident ~${(this.appendedBytes / 1024 / 1024).toFixed(0)} MB of ${(this.budgetBytes() / 1024 / 1024).toFixed(0)} MB · readyState ${this.element.readyState}${this.mediaNote ? ` · ${this.mediaNote}` : ""}`,
          bufferedSeconds: ahead,
          fetchedBytes: this.nextByte,
          ranges: this.describeRanges(),
        });
        continue;
      }
      const chunk = await this.fetchNext();
      if ("done" in chunk) {
        this.flush(true);
        const complete =
          this.totalBytes != null && this.nextByte >= this.totalBytes;
        this.onStatus({
          state: complete ? "ended" : "error",
          message: chunk.reason,
          bufferedSeconds: this.bufferedAhead(),
          fetchedBytes: this.nextByte,
        });
        return;
      }
      this.absorb(this.demuxer.push(chunk.bytes));
      this.flush(false);

      // Reading without the buffer advancing means the data is being fetched
      // and discarded — a parse that produces no frames, or appends that never
      // land. Downloading forever hides that, so it is called out.
      const end = this.bufferedEnd();
      if (end > this.lastBufferedEnd + 0.1) {
        this.lastBufferedEnd = end;
        this.bytesSinceProgress = 0;
      } else {
        this.bytesSinceProgress += chunk.bytes.byteLength;
        if (this.bytesSinceProgress > 48 * 1024 * 1024) {
          this.onStatus({
            state: "error",
            message: `Read 48 MB without the buffer advancing — segments are not landing. Buffered end stuck at ${end.toFixed(1)}s.`,
            ranges: this.describeRanges(),
            fetchedBytes: this.nextByte,
          });
          return;
        }
      }
      const held = [...this.pending.values()].reduce(
        (sum, frames) => sum + frames.length,
        0,
      );
      this.tryPlay();
      this.onStatus({
        state: this.bufferedAhead() > 1 ? "ready" : "buffering",
        message: `${(this.nextByte / 1024 / 1024).toFixed(1)} MB read · target ${this.targetAhead().toFixed(0)}s · resident ~${(this.appendedBytes / 1024 / 1024).toFixed(0)} MB of ${(this.budgetBytes() / 1024 / 1024).toFixed(0)} MB · queue ${this.queue.length} · ${held} frames held${this.mediaNote ? ` · ${this.mediaNote}` : ""}`,
        bufferedSeconds: this.bufferedAhead(),
        fetchedBytes: this.nextByte,
        ranges: this.describeRanges(),
      });
    }
  }

  /**
   * Reports why it stopped rather than just returning nothing. Ending because
   * the file ran out and ending because a request was refused look identical
   * from the loop, and they need completely different responses.
   */
  private async fetchNext(): Promise<
    { bytes: Uint8Array } | { done: true; reason: string }
  > {
    if (this.totalBytes != null && this.nextByte >= this.totalBytes)
      return {
        done: true,
        reason: `Reached the end of the file (${this.nextByte} of ${this.totalBytes} bytes).`,
      };
    this.fetching = true;
    try {
      return await this.fetchWithRetry();
    } finally {
      this.fetching = false;
    }
  }

  private async fetchWithRetry(): Promise<
    { bytes: Uint8Array } | { done: true; reason: string }
  > {
    let lastReason = "";
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      // A CDN link can expire mid-stream, so re-resolve before the last try
      // rather than giving up on a URL that has simply gone stale.
      if (attempt === FETCH_ATTEMPTS) await this.reresolve();
      const outcome = await this.fetchOnce();
      if (!("retry" in outcome)) return outcome;
      lastReason = outcome.reason;
      if (this.stopped) break;
      await new Promise((resolve) =>
        window.setTimeout(resolve, 400 * attempt),
      );
    }
    return {
      done: true,
      reason: `${lastReason} Gave up after ${FETCH_ATTEMPTS} attempts at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB.`,
    };
  }

  private async reresolve() {
    try {
      const head = await fetch(this.url, {
        headers: { Range: "bytes=0-1" },
        cache: "no-store",
      });
      if (head.url) this.resolvedUrl = head.url;
      await head.body?.cancel().catch(() => undefined);
    } catch {
      // Keep the previous URL; the retry will report if it still fails.
    }
  }

  private async fetchOnce(): Promise<
    { bytes: Uint8Array } | { done: true; reason: string } | { retry: true; reason: string }
  > {
    try {
      const end = this.nextByte + CHUNK_BYTES - 1;
      const response = await fetch(this.resolvedUrl || this.url, {
        headers: { Range: `bytes=${this.nextByte}-${end}` },
        cache: "no-store",
      });
      if (!response.ok && response.status !== 206)
        return {
          retry: true,
          reason: `Host answered HTTP ${response.status} at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB.`,
        };
      // Capped read, not arrayBuffer(): a host that ignores the range answers
      // with the whole file, and buffering that is an out-of-memory kill.
      const reader = response.body?.getReader();
      if (!reader)
        return { done: true, reason: "No readable stream from the host." };
      const parts: Uint8Array[] = [];
      let read = 0;
      while (read < CHUNK_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        parts.push(value);
        read += value.byteLength;
      }
      await reader.cancel().catch(() => undefined);
      if (read === 0) return { retry: true, reason: "Host returned no bytes." };
      const bytes = new Uint8Array(Math.min(read, CHUNK_BYTES));
      let offset = 0;
      for (const part of parts) {
        if (offset >= bytes.byteLength) break;
        bytes.set(part.subarray(0, bytes.byteLength - offset), offset);
        offset += part.byteLength;
      }
      // Advance by what was kept, not by what arrived: a 200 response would
      // otherwise skip the byte counter past the end of the file in one go.
      this.nextByte += bytes.byteLength;
      if (response.status !== 206 && this.nextByte > bytes.byteLength)
        return {
          done: true,
          reason: `Host stopped honouring ranges at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB (HTTP ${response.status}).`,
        };
      return { bytes };
    } catch (error) {
      return {
        retry: true,
        reason: `Range request failed: ${error instanceof Error ? error.message : "unknown"}.`,
      };
    }
  }

  /**
   * Keeps only what will be muxed.
   *
   * A file carries tracks we deliberately ignore — the TrueHD alongside the
   * E-AC-3, three subtitle tracks — and TrueHD alone emits about 1200 frames a
   * second. Holding those accumulates tens of megabytes of slices that are
   * never used, and on a phone the memory pressure stops playback long before
   * anything else fails.
   *
   * Before the track choice is made everything is kept, because choosing the
   * audio track needs a frame to read its configuration from.
   */
  private absorb(frames: StreamFrame[]) {
    const chosen = this.muxTracks.size > 0;
    for (const frame of frames) {
      if (chosen && !this.muxTracks.has(frame.track)) continue;
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
    // Discard what the priming phase collected for tracks now known to be
    // unused; without this the first seconds of TrueHD stay resident forever.
    for (const trackNumber of [...this.pending.keys()])
      if (!this.muxTracks.has(trackNumber)) this.pending.delete(trackNumber);
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
      const segment = buildMediaSegment(
        this.sequence++,
        trackNumber,
        Math.round(usable[0]!.timeMs),
        samples,
      );
      // Only the video track is measured: audio is a rounding error next to it
      // and counting both would double-count the same wall-clock seconds.
      if (track.kind === "video") {
        this.appendedBytes += segment.byteLength;
        this.appendedSeconds += span / 1000;
      }
      this.enqueue(segment);
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
        const freed = this.evict(true);
        // Eviction drives the retry through updateend. When it frees nothing —
        // the playhead is still near the start, so there is no history to drop
        // — nothing fires and the queue never drains again. Retry on a timer.
        if (!freed) window.setTimeout(() => this.pump(), 500);
        return;
      }
      this.onStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Append failed.",
      });
    }
  }

  /**
   * How many seconds to stay ahead, given how heavy this file turns out to be.
   * Falls back to the maximum until enough has been appended to judge.
   */
  private targetAhead() {
    if (this.appendedSeconds < 2 || this.appendedBytes === 0)
      return MAX_AHEAD_SECONDS;
    const affordable = this.budgetBytes() / this.bytesPerSecond();
    return Math.max(MIN_AHEAD_SECONDS, Math.min(MAX_AHEAD_SECONDS, affordable));
  }

  private bytesPerSecond() {
    if (this.appendedSeconds < 0.5 || this.appendedBytes === 0) return 0;
    return this.appendedBytes / this.appendedSeconds;
  }

  /**
   * The budget floor is a guess; what the file actually costs is not. A 90 Mbps
   * stream needs the minimum lead plus the history eviction keeps before it can
   * free anything, so the budget has to be at least that or it forbids the only
   * state from which it can recover. Past that, MSE is the authority: a quota
   * error is a real limit, an invented byte count is not.
   */
  private budgetBytes() {
    const rate = this.bytesPerSecond();
    if (!rate) return BUFFER_BUDGET_BYTES;
    const required = rate * (MIN_AHEAD_SECONDS + KEEP_BEHIND_SECONDS + 2);
    return Math.max(BUFFER_BUDGET_BYTES, required);
  }

  /** Human-readable buffered ranges, with the playhead marked. */
  private describeRanges() {
    const buffer = this.buffer;
    if (!buffer?.buffered.length) return "none";
    const parts: string[] = [];
    for (let index = 0; index < buffer.buffered.length; index += 1)
      parts.push(
        `${buffer.buffered.start(index).toFixed(1)}-${buffer.buffered.end(index).toFixed(1)}`,
      );
    return `${parts.join(", ")} @ ${this.element.currentTime.toFixed(1)}`;
  }

  private bufferedEnd() {
    const buffer = this.buffer;
    if (!buffer?.buffered.length) return 0;
    return buffer.buffered.end(buffer.buffered.length - 1);
  }

  private bufferedAhead() {
    const buffer = this.buffer;
    if (!buffer?.buffered.length) return 0;
    const time = this.element.currentTime;
    for (let index = 0; index < buffer.buffered.length; index += 1)
      if (time >= buffer.buffered.start(index) - 0.5 && time <= buffer.buffered.end(index))
        return buffer.buffered.end(index) - time;
    // Outside every range — before the first, or in a gap. Report what is
    // ready beyond the playhead so the loop still throttles rather than
    // treating it as an empty buffer.
    const end = this.bufferedEnd();
    return Math.max(0, end - time);
  }

  /** Returns whether anything was actually dropped. */
  private evict(aggressive = false) {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || !buffer.buffered.length) return false;
    const keep = aggressive ? 2 : KEEP_BEHIND_SECONDS;
    const cutoff = this.element.currentTime - keep;
    if (cutoff <= buffer.buffered.start(0) + 0.1) return false;
    try {
      const removed = cutoff - buffer.buffered.start(0);
      buffer.remove(buffer.buffered.start(0), cutoff);
      // The estimate tracks what is resident, so removal has to reduce it.
      const rate = this.bytesPerSecond();
      this.appendedBytes = Math.max(0, this.appendedBytes - removed * rate);
      this.appendedSeconds = Math.max(0, this.appendedSeconds - removed);
      return true;
    } catch {
      // Removal is best effort; the next pass will try again.
      return false;
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
