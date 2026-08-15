import { codecStringFor } from "./codecString";
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
 * A stalled fetch used to hang the whole loop with no way to tell: fetch has
 * no timeout of its own, so a host that accepts a connection and then stops
 * sending blocks forever and the last status line stands as the final word.
 */
const FETCH_TIMEOUT_MS = 30_000;
/** How long a single phase may last before it is reported as stuck. */
const STUCK_AFTER_MS = 12_000;
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
/**
 * A video fragment is cut at a keyframe, so it can run longer than the target
 * while waiting for one. Past this it is emitted regardless: a long GOP is
 * worth a non-conforming fragment less than it is worth a stall.
 */
const MAX_FRAGMENT_SECONDS = 12;

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
  /** What was handed to the SourceBuffer most recently. */
  private lastSegment = "";
  /** What the streamer is doing, and since when, so a hang names itself. */
  private phase = "idle";
  private phaseSince = Date.now();
  /** Why the last pump declined to append, which was previously invisible. */
  private pumpNote = "";
  private watchdog = 0;
  /** The MIME actually negotiated, worth seeing when a decoder refuses. */
  private mime = "";
  /**
   * Latches the first failure. Progress updates kept overwriting the reason a
   * run died — an element error would appear and be replaced by the next
   * "buffering" line before it could be read.
   */
  private failed = false;
  private closedWaits = 0;

  private enter(phase: string) {
    this.phase = phase;
    this.phaseSince = Date.now();
  }

  /**
   * Reports a phase that has outlasted anything reasonable. Every stall so far
   * has looked the same from outside — a status line that simply stops — and
   * this is what tells a blocked fetch apart from a blocked append.
   */
  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = window.setInterval(() => {
      if (this.stopped || this.failed) return;
      const held = Date.now() - this.phaseSince;
      if (held < STUCK_AFTER_MS) return;
      this.report({
        state: "error",
        message: `Stuck in "${this.phase}" for ${(held / 1000).toFixed(0)}s at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB · queue ${this.queue.length}${this.pumpNote ? ` · ${this.pumpNote}` : ""} · buffer ${this.buffer?.updating ? "updating" : "idle"} · source ${this.source?.readyState ?? "none"} · last segment ${this.lastSegment || "none"} · build ${__APP_BUILD__}`,
        ranges: this.describeRanges(),
        fetchedBytes: this.nextByte,
      });
    }, 2000);
  }

  private report(status: StreamerStatus) {
    if (this.failed && status.state !== "error") return;
    if (status.state === "error") this.failed = true;
    this.onStatus(status);
  }

  constructor(
    private readonly url: string,
    private readonly element: HTMLVideoElement,
    private readonly onStatus: (status: StreamerStatus) => void,
  ) {}

  stop() {
    this.stopped = true;
    if (this.watchdog) window.clearInterval(this.watchdog);
    this.watchdog = 0;
    this.queue = [];
    try {
      if (this.source?.readyState === "open") this.source.endOfStream();
    } catch {
      // Already torn down.
    }
  }

  async start() {
    this.report({ state: "starting", message: "Resolving source…" });
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
      this.report({
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
      this.report({ state: "error", message: "No track headers found." });
      return;
    }

    const tracks = this.chooseTracks();
    if (!tracks.length) {
      this.report({
        state: "error",
        message: "No track in this file can be remuxed here.",
      });
      return;
    }

    const mime = `video/mp4; codecs="${tracks.map(codecString).join(",")}"`;
    this.mime = mime;
    const Source =
      (window as unknown as { ManagedMediaSource?: typeof MediaSource })
        .ManagedMediaSource ?? window.MediaSource;
    if (!Source?.isTypeSupported(mime)) {
      this.report({ state: "error", message: `Browser rejects ${mime}.` });
      return;
    }

    const source = new Source();
    this.source = source as MediaSource;
    this.watchElement();
    this.element.disableRemotePlayback = true;
    this.element.src = URL.createObjectURL(source as unknown as MediaSource);

    // A MediaSource that closes takes every later call with it, so the moment
    // it happens is worth recording rather than inferring from the wreckage.
    source.addEventListener("sourceclose", () => {
      this.mediaNote = "MediaSource closed";
    });
    source.addEventListener("sourceended", () => {
      this.mediaNote = "MediaSource ended";
    });

    await new Promise<void>((resolve) =>
      source.addEventListener("sourceopen", () => resolve(), { once: true }),
    );
    if (this.stopped) return;

    try {
      const buffer = (source as MediaSource).addSourceBuffer(mime);
      this.buffer = buffer;
      buffer.addEventListener("updateend", () => this.pump());
      buffer.addEventListener("error", () =>
        this.report({
          state: "error",
          message: `SourceBuffer rejected a segment — ${this.lastSegment || "no segment recorded"} · element error ${this.element.error?.message || this.element.error?.code || "none"} · source ${this.source?.readyState ?? "none"}`,
          ranges: this.describeRanges(),
          fetchedBytes: this.nextByte,
        }),
      );
      // Best effort: a rejected duration costs a seek bar, not playback.
      try {
        if (this.demuxer.durationSeconds)
          (source as MediaSource).duration = this.demuxer.durationSeconds;
      } catch (error) {
        this.mediaNote = `duration rejected (${describeError(error)})`;
      }
      this.enqueue(buildInitSegment(tracks));
    } catch (error) {
      this.report({
        state: "error",
        message: error instanceof Error ? error.message : "Could not open a buffer.",
      });
      return;
    }

    this.startWatchdog();
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
      this.report({
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
      this.report({
        state: "error",
        message: `Streaming stopped: ${describeError(error)} · source ${this.source?.readyState ?? "none"} · at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB`,
        ranges: this.describeRanges(),
        fetchedBytes: this.nextByte,
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
        this.enter("holding");
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        this.evict();
        this.tryPlay();
        this.report({
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
        this.report({
          state: complete ? "ended" : "error",
          message: chunk.reason,
          bufferedSeconds: this.bufferedAhead(),
          fetchedBytes: this.nextByte,
        });
        return;
      }
      this.enter("demuxing");
      this.absorb(this.demuxer.push(chunk.bytes));
      this.flush(false);
      this.enter("waiting on the buffer");

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
          this.report({
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
      this.report({
        state: this.bufferedAhead() > 1 ? "ready" : "buffering",
        message: `${(this.nextByte / 1024 / 1024).toFixed(1)} MB read · target ${this.targetAhead().toFixed(0)}s · resident ~${(this.appendedBytes / 1024 / 1024).toFixed(0)} MB of ${(this.budgetBytes() / 1024 / 1024).toFixed(0)} MB · queue ${this.queue.length} · ${held} frames held · ${this.mime} · ${__APP_BUILD__}${this.mediaNote ? ` · ${this.mediaNote}` : ""}`,
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
    this.enter(`fetching ${(this.nextByte / 1024 / 1024).toFixed(0)}-${((this.nextByte + CHUNK_BYTES) / 1024 / 1024).toFixed(0)} MB`);
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
    // fetch waits forever by default, so a host that accepts the connection and
    // then goes quiet hangs the loop with nothing to show for it. The deadline
    // is on silence, not on the transfer: an 8 MB chunk is allowed to take as
    // long as it needs provided it keeps arriving.
    const abort = new AbortController();
    let idle = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    const keepAlive = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    };
    try {
      const end = this.nextByte + CHUNK_BYTES - 1;
      const response = await fetch(this.resolvedUrl || this.url, {
        headers: { Range: `bytes=${this.nextByte}-${end}` },
        cache: "no-store",
        signal: abort.signal,
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
        keepAlive();
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
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      return {
        retry: true,
        reason: timedOut
          ? `Host went quiet for ${FETCH_TIMEOUT_MS / 1000}s at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB.`
          : `Range request failed: ${describeError(error)}.`,
      };
    } finally {
      window.clearTimeout(idle);
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
      let usable = final ? frames : frames.slice(0, -1);
      // Reordered video arrives out of presentation order, so the span is the
      // spread of the timestamps rather than the difference across the ends.
      let span = spanOf(usable);
      if (!final && span < FRAGMENT_SECONDS * 1000) continue;

      // Video fragments are cut at a keyframe so every one of them opens on a
      // sync sample. Cutting mid-GOP leaves a fragment whose first sample
      // depends on frames in the previous one, which Safari is entitled to
      // reject outright — and which makes seeking impossible later regardless.
      if (track.kind === "video" && !final) {
        let cut = -1;
        for (let index = usable.length - 1; index > 0; index -= 1)
          if (usable[index]!.keyframe) {
            cut = index;
            break;
          }
        if (cut > 0) usable = usable.slice(0, cut);
        else if (span < MAX_FRAGMENT_SECONDS * 1000) continue;
        span = spanOf(usable);
      }

      // Matroska stores frames in decode order and stamps them with their
      // presentation time; MP4 wants decode times in tfdt and trun, with the
      // difference carried as a composition offset. Sorting the presentation
      // times recovers the decode timeline: the set is the same, only the
      // order differs, so the nth frame to be decoded is due at the nth
      // smallest timestamp. Without this a B-frame's negative gap became a
      // one-tick duration and the timeline collapsed.
      const decodeTimes = usable.map((frame) => frame.timeMs).sort((a, b) => a - b);
      const samples = usable.map((frame, index) => {
        const decode = decodeTimes[index]!;
        const next = decodeTimes[index + 1];
        const duration = next != null ? next - decode : lastGap(decodeTimes);
        return {
          data: frame.data,
          durationTicks: Math.max(1, Math.round(duration)),
          keyframe: frame.keyframe,
          compositionOffsetTicks: Math.round(frame.timeMs - decode),
        };
      });
      const segment = buildMediaSegment(
        this.sequence++,
        trackNumber,
        Math.round(decodeTimes[0]!),
        samples,
      );
      // The SourceBuffer error event says nothing about what it rejected, so
      // the last thing handed to it is worth remembering.
      const reordered = samples.some((sample) => sample.compositionOffsetTicks !== 0);
      this.lastSegment = `track ${trackNumber} ${track.kind} · ${samples.length} samples · ${(decodeTimes[0]! / 1000).toFixed(2)}-${(decodeTimes.at(-1)! / 1000).toFixed(2)}s · ${usable[0]!.keyframe ? "opens on keyframe" : "MID-GOP"}${reordered ? " · reordered" : ""} · ${(segment.byteLength / 1024).toFixed(0)} KB`;
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
    if (!buffer) {
      this.pumpNote = "no buffer yet";
      return;
    }
    if (this.stopped) return;
    if (buffer.updating) {
      // Normal between appends; only a lasting one matters, and the watchdog
      // is what decides that.
      this.pumpNote = "buffer busy";
      return;
    }
    // Every MSE call throws InvalidStateError once the MediaSource stops being
    // open, and the exception does not say which object it meant. Checking
    // first turns that into a state we can report — and a closed source is
    // worth waiting on, because a ManagedMediaSource detaches under memory
    // pressure and can be reattached rather than being a dead end.
    if (this.source?.readyState !== "open") {
      this.pumpNote = `source ${this.source?.readyState ?? "detached"}`;
      this.closedWaits += 1;
      // Waiting forever would turn a dead source into a silent hang, which is
      // exactly the failure this guard was added to make visible.
      if (this.closedWaits > 20) {
        this.report({
          state: "error",
          message: `MediaSource has been ${this.source?.readyState ?? "detached"} for 10s · ${this.mime} · element error ${this.element.error?.message || this.element.error?.code || "none"} · last segment ${this.lastSegment || "none"}`,
          ranges: this.describeRanges(),
          fetchedBytes: this.nextByte,
        });
        return;
      }
      window.setTimeout(() => this.pump(), 500);
      return;
    }
    this.closedWaits = 0;
    const next = this.queue.shift();
    if (!next) {
      this.pumpNote = "queue empty";
      return;
    }
    try {
      this.pumpNote = `appending ${(next.byteLength / 1024).toFixed(0)} KB`;
      buffer.appendBuffer(next as unknown as BufferSource);
    } catch (error) {
      // A quota error means eviction has to happen before this can retry.
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        this.queue.unshift(next);
        const freed = this.evict(true);
        // Eviction drives the retry through updateend. When it frees nothing —
        // the playhead is still near the start, so there is no history to drop
        // — nothing fires and the queue never drains again. Retry on a timer.
        this.pumpNote = `quota exceeded on ${(next.byteLength / 1024).toFixed(0)} KB, ${freed ? "evicting" : "nothing to evict"}`;
        if (!freed) window.setTimeout(() => this.pump(), 500);
        return;
      }
      this.report({
        state: "error",
        message: `Append failed: ${describeError(error)} · source ${this.source?.readyState ?? "none"} · updating ${buffer.updating} · queue ${this.queue.length} · segment ${(next.byteLength / 1024).toFixed(0)} KB · readyState ${this.element.readyState}`,
        ranges: this.describeRanges(),
        fetchedBytes: this.nextByte,
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
    if (this.source?.readyState !== "open") return false;
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

/** Spread of presentation times, which is not the gap across the ends. */
function spanOf(frames: StreamFrame[]) {
  let low = Infinity;
  let high = -Infinity;
  for (const frame of frames) {
    if (frame.timeMs < low) low = frame.timeMs;
    if (frame.timeMs > high) high = frame.timeMs;
  }
  return high - low;
}

/** The final sample has no successor, so it inherits the preceding gap. */
function lastGap(times: number[]) {
  if (times.length < 2) return 40;
  return Math.max(1, times.at(-1)! - times.at(-2)!);
}

/**
 * A DOMException's message is generic — "The object is in an invalid state"
 * names neither the object nor the call. The name is the useful half.
 */
function describeError(error: unknown) {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : "unknown";
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

const codecString = (track: MuxTrack) =>
  codecStringFor(track.sampleEntry, track.config);
