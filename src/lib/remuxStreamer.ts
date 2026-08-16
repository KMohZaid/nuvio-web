import { codecStringFor } from "./codecString";
import {
  buildInitSegment,
  buildMediaSegment,
  type MuxSample,
  type MuxTrack,
} from "./fmp4";
import { MatroskaStream, type StreamFrame } from "./matroskaStream";
import { describeTrack } from "./remux";
import {
  parseContentRange,
  partialResponseMatches,
  reachedDeclaredRangeEnd,
} from "./httpRange";
import {
  fragmentCutIndex,
  initialFragmentStartIndex,
} from "./remuxFragments";
import {
  shouldManuallyEvict,
  shouldPauseManagedBuffering,
  shouldPauseForRemuxQueue,
  shouldReportNoAppendProgress,
} from "./remuxBufferPolicy";
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
/** Header/track priming must not accumulate a normal 8 MB media chunk. */
const PRIME_CHUNK_BYTES = 512 * 1024;
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
/** iOS WebContent has a much tighter practical memory ceiling than desktop. */
const MANAGED_BUFFER_BUDGET_BYTES = 24 * 1024 * 1024;
const MANAGED_MAX_AHEAD_SECONDS = 12;
const MANAGED_MIN_AHEAD_SECONDS = 4;
/** Remuxed fragments waiting for SourceBuffer need their own hard ceiling. */
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_SEGMENTS = 32;
/** How much history to keep before evicting; MSE throws when the quota goes. */
const KEEP_BEHIND_SECONDS = 6;
export type StreamerStatus = {
  state: "idle" | "starting" | "buffering" | "ready" | "ended" | "error";
  message: string;
  bufferedSeconds?: number;
  fetchedBytes?: number;
  /** Rendered verbatim: a gap between ranges is the thing to look for. */
  ranges?: string;
};

export type RemuxStreamerOptions = {
  /** Request headers supplied by the Stremio stream behavior hints. */
  requestHeaders?: Record<string, string>;
};

export class RemuxStreamer {
  private demuxer = new MatroskaStream();
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private pending = new Map<number, StreamFrame[]>();
  private muxTracks = new Map<number, MuxTrack>();
  /** Tracks that have already emitted their initial random-access fragment. */
  private startedTracks = new Set<number>();
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
  private activeAbort: AbortController | null = null;
  /** Used when a host ignores Range and returns one ordinary HTTP 200 body. */
  private sequentialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private sequentialRemainder: Uint8Array | null = null;
  private sequentialDone = false;
  private eofPending = false;
  private eofReason = "";
  private objectUrl = "";
  private cleanups: Array<() => void> = [];
  private selectionError = "";
  /** MMS performs its own active cleanup and must not be trimmed continuously. */
  private managedMediaSource = false;
  /** Set by MMS startstreaming/endstreaming demand signals. */
  private managedWantsData = true;

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
    if (this.stopped) return;
    if (this.failed && status.state !== "error") return;
    if (status.state === "error") this.failed = true;
    this.onStatus(status);
  }

  constructor(
    private readonly url: string,
    private readonly element: HTMLVideoElement,
    private readonly onStatus: (status: StreamerStatus) => void,
    private readonly options: RemuxStreamerOptions = {},
  ) {}

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.activeAbort?.abort();
    this.activeAbort = null;
    void this.sequentialReader?.cancel().catch(() => undefined);
    this.sequentialReader = null;
    this.sequentialRemainder = null;
    if (this.watchdog) window.clearInterval(this.watchdog);
    this.watchdog = 0;
    this.queue = [];
    this.queuedBytes = 0;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Teardown is best effort; continue releasing the remaining handles.
      }
    }
    // Do not call endOfStream here. Closing/backing out is not natural EOF,
    // and Safari otherwise fires `ended` and records an unfinished title as
    // watched.
    if (this.objectUrl) {
      if (this.element.src === this.objectUrl) {
        this.element.pause();
        this.element.removeAttribute("src");
        this.element.load();
      }
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = "";
    }
    this.buffer = null;
    this.source = null;
  }

  async start() {
    this.report({ state: "starting", message: "Resolving source…" });
    const resolveAbort = this.beginFetch();
    try {
      // One resolution up front: debrid links redirect, and the Range header
      // does not survive the hop.
      const head = await fetch(this.url, {
        headers: this.headersFor(this.url, "bytes=0-1"),
        cache: "no-store",
        signal: resolveAbort.signal,
      });
      this.resolvedUrl = head.url || this.url;
      const contentRange = head.headers.get("content-range");
      const range = parseContentRange(contentRange);
      if (partialResponseMatches(head.status, contentRange, 0)) {
        if (range?.total != null) this.totalBytes = range.total;
        await head.body?.cancel().catch(() => undefined);
      } else if (head.status === 200 && head.body) {
        // Some storage/CDN endpoints ignore Range. Keep this response open and
        // consume it once instead of repeatedly downloading the first 8 MB.
        this.sequentialReader = head.body.getReader();
        const length = Number(head.headers.get("content-length"));
        this.totalBytes = Number.isSafeInteger(length) && length > 0 ? length : null;
      } else {
        await head.body?.cancel().catch(() => undefined);
        throw new Error(
          head.status === 206
            ? "The media host returned an invalid byte range."
            : `The media host answered HTTP ${head.status}.`,
        );
      }
    } catch (error) {
      this.report({
        state: "error",
        message: error instanceof Error ? error.message : "Could not reach the source.",
      });
      return;
    } finally {
      // The abort signal owns the retained HTTP 200 stream for its lifetime.
      if (!this.sequentialReader) this.finishFetch(resolveAbort);
    }

    // Read until the demuxer has the track headers, which is what the init
    // segment is built from.
    // Read past the headers into the first cluster: choosing an audio track
    // needs a frame in hand, because AC-3 config is read from the bitstream.
    while (!this.stopped && !this.primingComplete()) {
      const chunk = await this.fetchNext(PRIME_CHUNK_BYTES);
      if ("failed" in chunk) {
        this.report({ state: "error", message: chunk.reason });
        return;
      }
      if ("done" in chunk) break;
      this.absorb(this.demuxer.push(chunk.bytes));
    }
    if (this.stopped) return;
    if (!this.demuxer.headerComplete) {
      this.report({ state: "error", message: "No track headers found." });
      return;
    }

    const ManagedSource = (
      window as unknown as { ManagedMediaSource?: typeof MediaSource }
    ).ManagedMediaSource;
    const Source = ManagedSource ?? window.MediaSource;
    if (!Source) {
      this.report({ state: "error", message: "Media Source is unavailable." });
      return;
    }
    const tracks = this.chooseTracks(Source);
    if (!tracks.length) {
      this.report({
        state: "error",
        message:
          this.selectionError || "No track in this file can be remuxed here.",
      });
      return;
    }

    const mime = `video/mp4; codecs="${tracks.map(codecString).join(",")}"`;
    this.mime = mime;
    if (!Source?.isTypeSupported(mime)) {
      this.report({ state: "error", message: `Browser rejects ${mime}.` });
      return;
    }

    const source = new Source();
    this.managedMediaSource = Boolean(ManagedSource && Source === ManagedSource);
    this.managedWantsData = true;
    this.source = source as MediaSource;
    this.watchElement();
    this.element.disableRemotePlayback = true;

    if (this.managedMediaSource) {
      const managed = source as MediaSource & {
        addEventListener(type: "startstreaming" | "endstreaming", listener: EventListener): void;
        removeEventListener(type: "startstreaming" | "endstreaming", listener: EventListener): void;
      };
      const onStartStreaming: EventListener = () => {
        this.managedWantsData = true;
        this.mediaNote = "ManagedMediaSource requested data";
        this.pump();
      };
      const onEndStreaming: EventListener = () => {
        this.managedWantsData = false;
        this.mediaNote = "ManagedMediaSource has enough data";
      };
      managed.addEventListener("startstreaming", onStartStreaming);
      managed.addEventListener("endstreaming", onEndStreaming);
      this.cleanups.push(() => {
        managed.removeEventListener("startstreaming", onStartStreaming);
        managed.removeEventListener("endstreaming", onEndStreaming);
      });
    }
    this.objectUrl = URL.createObjectURL(source as unknown as MediaSource);
    this.element.src = this.objectUrl;

    // A MediaSource that closes takes every later call with it, so the moment
    // it happens is worth recording rather than inferring from the wreckage.
    const onSourceClose = () => {
      this.mediaNote = "MediaSource closed";
    };
    const onSourceEnded = () => {
      this.mediaNote = "MediaSource ended";
    };
    source.addEventListener("sourceclose", onSourceClose);
    source.addEventListener("sourceended", onSourceEnded);
    this.cleanups.push(() => {
      source.removeEventListener("sourceclose", onSourceClose);
      source.removeEventListener("sourceended", onSourceEnded);
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        source.removeEventListener("sourceopen", finish);
        source.removeEventListener("sourceclose", finish);
        resolve();
      };
      source.addEventListener("sourceopen", finish, { once: true });
      source.addEventListener("sourceclose", finish, { once: true });
      this.cleanups.push(finish);
      if (this.stopped) finish();
    });
    if (this.stopped || source.readyState !== "open") return;

    try {
      const buffer = (source as MediaSource).addSourceBuffer(mime);
      this.buffer = buffer;
      const onUpdateEnd = () => {
        // appendBuffer is asynchronous. A completed update is real producer
        // progress even when the public buffered range cannot advance until
        // the other track catches up.
        this.bytesSinceProgress = 0;
        this.lastBufferedEnd = Math.max(
          this.lastBufferedEnd,
          this.bufferedEnd(),
        );
        this.pump();
      };
      const onBufferedChange: EventListener = () => {
        // ManagedSourceBuffer can evict ranges without a remove() call.
        // Observe what WebKit actually retained instead of trusting append
        // history when deciding whether more data is needed.
        this.lastBufferedEnd = this.bufferedEnd();
        this.mediaNote = "ManagedMediaSource buffer changed";
        this.pump();
      };
      const onBufferError = () =>
        this.report({
          state: "error",
          message: `SourceBuffer rejected a segment — ${this.lastSegment || "no segment recorded"} · element error ${this.element.error?.message || this.element.error?.code || "none"} · source ${this.source?.readyState ?? "none"}`,
          ranges: this.describeRanges(),
          fetchedBytes: this.nextByte,
        });
      buffer.addEventListener("updateend", onUpdateEnd);
      buffer.addEventListener("error", onBufferError);
      if (this.managedMediaSource)
        (buffer as SourceBuffer & {
          addEventListener(type: "bufferedchange", listener: EventListener): void;
          removeEventListener(type: "bufferedchange", listener: EventListener): void;
        }).addEventListener("bufferedchange", onBufferedChange);
      this.cleanups.push(() => {
        buffer.removeEventListener("updateend", onUpdateEnd);
        buffer.removeEventListener("error", onBufferError);
        if (this.managedMediaSource)
          (buffer as SourceBuffer & {
            addEventListener(type: "bufferedchange", listener: EventListener): void;
            removeEventListener(type: "bufferedchange", listener: EventListener): void;
          }).removeEventListener("bufferedchange", onBufferedChange);
      });
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
    for (const event of ["waiting", "stalled", "playing", "pause", "seeking"]) {
      const listener = () => note(event);
      this.element.addEventListener(event, listener);
      this.cleanups.push(() => this.element.removeEventListener(event, listener));
    }
    const onError = () => {
      const error = this.element.error;
      note(`element error ${error?.code ?? "?"}: ${error?.message || "no detail"}`);
      this.report({
        state: "error",
        message: `The video element rejected the stream — ${error?.message || `code ${error?.code}`}.`,
        ranges: this.describeRanges(),
        fetchedBytes: this.nextByte,
      });
    };
    this.element.addEventListener("error", onError);
    this.cleanups.push(() => this.element.removeEventListener("error", onError));
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
      // ManagedMediaSource performs active cleanup itself. Its buffered ranges
      // are authoritative; our cumulative appended-byte estimate is not,
      // because WebKit can evict data without going through SourceBuffer.remove.
      const overBudget =
        !this.managedMediaSource &&
        ahead >= MIN_AHEAD_SECONDS &&
        this.appendedBytes > this.budgetBytes();
      const managedPaused = shouldPauseManagedBuffering(
        this.managedMediaSource,
        this.managedWantsData,
        ahead,
      );
      const queueBacklogged = shouldPauseForRemuxQueue(
        this.queuedBytes,
        this.queue.length,
        MAX_QUEUED_BYTES,
        MAX_QUEUED_SEGMENTS,
      );
      if (
        ahead > this.targetAhead() ||
        overBudget ||
        managedPaused ||
        queueBacklogged ||
        this.fetching
      ) {
        this.enter("holding");
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (shouldManuallyEvict(this.managedMediaSource, overBudget))
          this.evict();
        this.tryPlay();
        this.report({
          state: "ready",
          message: `Holding · ${(this.nextByte / 1024 / 1024).toFixed(0)} MB read · target ${this.targetAhead().toFixed(0)}s · queued ${(this.queuedBytes / 1024 / 1024).toFixed(1)} MB/${this.queue.length} · resident ~${(this.appendedBytes / 1024 / 1024).toFixed(0)} MB of ${(this.budgetBytes() / 1024 / 1024).toFixed(0)} MB · readyState ${this.element.readyState}${this.mediaNote ? ` · ${this.mediaNote}` : ""}`,
          bufferedSeconds: ahead,
          fetchedBytes: this.nextByte,
          ranges: this.describeRanges(),
        });
        continue;
      }
      const chunk = await this.fetchNext();
      if ("failed" in chunk) {
        this.report({
          state: "error",
          message: chunk.reason,
          bufferedSeconds: this.bufferedAhead(),
          fetchedBytes: this.nextByte,
        });
        return;
      }
      if ("done" in chunk) {
        this.flush(true);
        this.eofPending = true;
        this.eofReason = chunk.reason;
        this.pump();
        this.report({
          state: "ready",
          message: "Finishing the final buffered segment…",
          bufferedSeconds: this.bufferedAhead(),
          fetchedBytes: this.nextByte,
        });
        return;
      }
      this.enter("demuxing");
      this.absorb(this.demuxer.push(chunk.bytes));
      this.flush(false);
      this.enter("waiting on the buffer");
      const held = [...this.pending.values()].reduce(
        (sum, frames) => sum + frames.length,
        0,
      );

      // Reading without the buffer advancing means the data is being fetched
      // and discarded — a parse that produces no frames, or appends that never
      // land. Downloading forever hides that, so it is called out.
      const end = this.bufferedEnd();
      if (end > this.lastBufferedEnd + 0.1) {
        this.lastBufferedEnd = end;
        this.bytesSinceProgress = 0;
      } else {
        this.bytesSinceProgress += chunk.bytes.byteLength;
        if (
          shouldReportNoAppendProgress(
            this.bytesSinceProgress,
            Boolean(this.buffer?.updating),
            this.queue.length,
          )
        ) {
          this.report({
            state: "error",
            message: `Read 48 MB without the buffer advancing — segments are not landing. Buffered end stuck at ${end.toFixed(1)}s · queue ${this.queue.length}/${(this.queuedBytes / 1024 / 1024).toFixed(1)} MB · ${held} frames held · parser ${(this.demuxer.buffered / 1024 / 1024).toFixed(1)} MB · last ${this.lastSegment || "none"}.`,
            ranges: this.describeRanges(),
            fetchedBytes: this.nextByte,
          });
          return;
        }
      }
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
  private async fetchNext(maxBytes = CHUNK_BYTES): Promise<
    | { bytes: Uint8Array }
    | { done: true; reason: string }
    | { failed: true; reason: string }
  > {
    if (
      reachedDeclaredRangeEnd(
        this.nextByte,
        this.totalBytes,
        this.sequentialReader != null,
      )
    )
      return {
        done: true,
        reason: `Reached the end of the file (${this.nextByte} of ${this.totalBytes} bytes).`,
      };
    this.fetching = true;
    this.enter(`fetching ${(this.nextByte / 1024 / 1024).toFixed(1)}-${((this.nextByte + maxBytes) / 1024 / 1024).toFixed(1)} MB`);
    try {
      return await this.fetchWithRetry(maxBytes);
    } finally {
      this.fetching = false;
    }
  }

  private async fetchWithRetry(maxBytes: number): Promise<
    | { bytes: Uint8Array }
    | { done: true; reason: string }
    | { failed: true; reason: string }
  > {
    if (this.sequentialReader) return this.readSequentialChunk(maxBytes);
    let lastReason = "";
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      // A CDN link can expire mid-stream, so re-resolve before the last try
      // rather than giving up on a URL that has simply gone stale.
      if (attempt === FETCH_ATTEMPTS) await this.reresolve();
      const outcome = await this.fetchOnce(maxBytes);
      if (!("retry" in outcome)) return outcome;
      lastReason = outcome.reason;
      if (this.stopped) break;
      await new Promise((resolve) =>
        window.setTimeout(resolve, 400 * attempt),
      );
    }
    return {
      failed: true,
      reason: `${lastReason} Gave up after ${FETCH_ATTEMPTS} attempts at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB.`,
    };
  }

  /** Reads one bounded chunk from a host that returned a single HTTP 200 body. */
  private async readSequentialChunk(maxBytes: number): Promise<
    { bytes: Uint8Array } | { done: true; reason: string } | { failed: true; reason: string }
  > {
    const reader = this.sequentialReader;
    if (!reader) return { failed: true, reason: "The sequential media response was lost." };
    if (this.sequentialDone && !this.sequentialRemainder)
      return { done: true, reason: "Reached the end of the media response." };

    const output = new Uint8Array(maxBytes);
    let written = 0;
    const append = (value: Uint8Array) => {
      const count = Math.min(value.byteLength, maxBytes - written);
      output.set(value.subarray(0, count), written);
      written += count;
      this.sequentialRemainder =
        count < value.byteLength ? value.subarray(count) : null;
    };

    if (this.sequentialRemainder) append(this.sequentialRemainder);
    try {
      while (written < maxBytes && !this.sequentialDone) {
        const result = await reader.read();
        if (result.done || !result.value) {
          this.sequentialDone = true;
          break;
        }
        append(result.value);
      }
    } catch (error) {
      return {
        failed: true,
        reason: `Sequential media read failed: ${describeError(error)}.`,
      };
    }
    if (written === 0) {
      // The stream reader, rather than a possibly transformed/misreported
      // Content-Length, is authoritative for an ordinary HTTP 200 response.
      this.totalBytes = this.nextByte;
      return { done: true, reason: "Reached the end of the media response." };
    }
    const bytes = output.subarray(0, written);
    this.nextByte += written;
    if (this.sequentialDone && !this.sequentialRemainder)
      this.totalBytes = this.nextByte;
    return { bytes };
  }

  private beginFetch() {
    const controller = new AbortController();
    this.activeAbort = controller;
    return controller;
  }

  private finishFetch(controller: AbortController) {
    if (this.activeAbort === controller) this.activeAbort = null;
  }

  /**
   * Combines the addon's request headers with our byte range.
   *
   * Credentials intended for the source origin are never replayed onto a
   * cross-origin redirect target. Fetch itself applies the same protection to
   * Authorization during a redirect; resolving the CDN URL first must not
   * accidentally weaken it.
   */
  private headersFor(target: string, range: string) {
    const headers = new Headers();
    let sameOrigin = target === this.url;
    try {
      sameOrigin =
        new URL(target, window.location.href).origin ===
        new URL(this.url, window.location.href).origin;
    } catch {
      // Relative or opaque targets are treated as the original source.
    }
    if (sameOrigin) {
      for (const [name, value] of Object.entries(
        this.options.requestHeaders ?? {},
      )) {
        const lower = name.toLowerCase();
        if (
          lower === "range" ||
          lower === "host" ||
          lower === "content-length" ||
          lower === "connection" ||
          lower === "origin" ||
          lower === "referer" ||
          lower.startsWith("sec-") ||
          typeof value !== "string"
        )
          continue;
        try {
          headers.set(name, value);
        } catch {
          // A malformed addon-supplied header must not abort playback setup.
        }
      }
    }
    headers.set("Range", range);
    return headers;
  }

  private async reresolve() {
    if (this.stopped) return;
    const controller = this.beginFetch();
    try {
      const head = await fetch(this.url, {
        headers: this.headersFor(this.url, "bytes=0-1"),
        cache: "no-store",
        signal: controller.signal,
      });
      if (head.url) this.resolvedUrl = head.url;
      await head.body?.cancel().catch(() => undefined);
    } catch {
      // Keep the previous URL; the retry will report if it still fails.
    } finally {
      this.finishFetch(controller);
    }
  }

  private async fetchOnce(maxBytes: number): Promise<
    | { bytes: Uint8Array }
    | { done: true; reason: string }
    | { retry: true; reason: string }
  > {
    if (this.stopped)
      return { done: true, reason: "Playback was stopped." };
    // fetch waits forever by default, so a host that accepts the connection and
    // then goes quiet hangs the loop with nothing to show for it. The deadline
    // is on silence, not on the transfer: an 8 MB chunk is allowed to take as
    // long as it needs provided it keeps arriving.
    const abort = this.beginFetch();
    let idle = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    const keepAlive = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    };
    try {
      const end = this.nextByte + maxBytes - 1;
      const target = this.resolvedUrl || this.url;
      const response = await fetch(target, {
        headers: this.headersFor(target, `bytes=${this.nextByte}-${end}`),
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok && response.status !== 206)
        return {
          retry: true,
          reason: `Host answered HTTP ${response.status} at ${(this.nextByte / 1024 / 1024).toFixed(1)} MB.`,
        };
      const contentRange = response.headers.get("content-range");
      const returnedRange = parseContentRange(contentRange);
      if (!partialResponseMatches(response.status, contentRange, this.nextByte)) {
        await response.body?.cancel().catch(() => undefined);
        return {
          retry: true,
          reason:
            response.status !== 206
              ? `Host stopped honouring byte ranges (HTTP ${response.status}).`
              : `Host returned the wrong range (wanted ${this.nextByte}, received ${returnedRange?.start ?? "invalid"}).`,
        };
      }
      if (returnedRange?.total != null) this.totalBytes = returnedRange.total;
      // Capped read, not arrayBuffer(): a host that ignores the range answers
      // with the whole file, and buffering that is an out-of-memory kill.
      const reader = response.body?.getReader();
      if (!reader)
        return { retry: true, reason: "Host returned no readable response body." };
      // Fill one range-sized allocation directly. The old parts[] + combine
      // path kept both copies alive at once (about 16 MB per 8 MB request),
      // which is especially costly inside iOS's memory-limited WebContent
      // process.
      const output = new Uint8Array(maxBytes);
      let read = 0;
      while (read < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        keepAlive();
        const kept = Math.min(value.byteLength, maxBytes - read);
        output.set(value.subarray(0, kept), read);
        read += kept;
      }
      await reader.cancel().catch(() => undefined);
      if (read === 0) return { retry: true, reason: "Host returned no bytes." };
      const bytes = read === output.byteLength ? output : output.slice(0, read);
      // Advance by what was kept, not by what arrived: a 200 response would
      // otherwise skip the byte counter past the end of the file in one go.
      this.nextByte += bytes.byteLength;
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
      this.finishFetch(abort);
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

  /**
   * Track headers are sufficient except for Dolby audio, whose MP4 decoder
   * configuration is derived from the first encoded frame. The previous
   * implementation always read two normal 8 MB chunks here; on iOS that
   * created one enormous first fragment and exhausted SourceBuffer quota
   * before a single frame could play.
   */
  private primingComplete() {
    if (!this.demuxer.headerComplete) return false;
    const audio = this.demuxer.tracks.filter((track) => track.kind === "audio");
    if (!audio.length) return true;
    const readyFromHeader = audio.some(
      (track) =>
        track.codecId.toUpperCase().startsWith("A_AAC") &&
        Boolean(track.codecPrivate?.byteLength),
    );
    if (readyFromHeader) return true;
    const dolby = audio.filter((track) => {
      const codec = track.codecId.toUpperCase();
      return codec.startsWith("A_AC3") || codec.startsWith("A_EAC3");
    });
    if (!dolby.length) return true;
    return dolby.some((track) => Boolean(this.pending.get(track.number)?.length));
  }

  private chooseTracks(Source: typeof MediaSource): MuxTrack[] {
    this.selectionError = "";
    this.muxTracks.clear();
    const videos = this.demuxer.tracks
      .filter((track) => track.kind === "video")
      .map((track) => describeTrack(asHeader(track), track.width, track.height))
      .filter((track): track is MuxTrack => !("reason" in track));
    const sourceAudio = this.demuxer.tracks.filter(
      (track) => track.kind === "audio",
    );
    // Prefer an audio track whose config can actually be built, which skips
    // TrueHD/DTS in favour of an AAC, AC-3 or E-AC-3 compatibility track.
    const audios = sourceAudio
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
      .filter((track): track is MuxTrack => !("reason" in track));

    let wanted: MuxTrack[] = [];
    for (const video of videos) {
      if (!sourceAudio.length) {
        const videoMime = `video/mp4; codecs="${codecString(video)}"`;
        if (Source.isTypeSupported(videoMime)) {
          wanted = [video];
          break;
        }
      }
      for (const audio of audios) {
        const candidate = [video, audio];
        const mime = `video/mp4; codecs="${candidate.map(codecString).join(",")}"`;
        if (Source.isTypeSupported(mime)) {
          wanted = candidate;
          break;
        }
      }
      if (wanted.length) break;
    }

    if (!wanted.length) {
      if (!videos.length) {
        this.selectionError =
          "The video codec in this Matroska source is not supported by this browser.";
      } else if (sourceAudio.length && !audios.length) {
        const codecs = [...new Set(sourceAudio.map((track) => track.codecId))];
        this.selectionError = `This source only has ${codecs.join(", ")} audio. Remuxing cannot decode or transcode it; use an external player or choose a source with AAC, AC-3 or E-AC-3 audio.`;
      } else if (sourceAudio.length) {
        this.selectionError =
          "This browser does not support the video's audio and video codec combination. Use an external player or another source.";
      }
      return [];
    }
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
    const built: Array<{
      startMs: number;
      trackNumber: number;
      track: MuxTrack;
      samples: MuxSample[];
      endMs: number;
      spanMs: number;
      opensOnKeyframe: boolean;
      reordered: boolean;
    }> = [];
    for (const [trackNumber, frames] of this.pending) {
      const track = this.muxTracks.get(trackNumber);
      if (!track) continue;
      let remaining = frames;

      // Starting midway through a GOP can only produce undecodable video. This
      // is normally zero frames, but protects sources whose first Cluster does
      // not begin on a random-access point.
      if (track.kind === "video" && remaining.length) {
        const firstSync = initialFragmentStartIndex(
          remaining,
          this.startedTracks.has(trackNumber),
        );
        if (firstSync < 0) {
          this.pending.set(trackNumber, final ? [] : remaining);
          continue;
        }
        if (firstSync > 0) remaining = remaining.slice(firstSync);
      }

      while (remaining.length >= 2) {
        // Hold one future timestamp during normal streaming so the final
        // sample gets a real duration instead of a guess.
        const available = final ? remaining : remaining.slice(0, -1);
        const cut = fragmentCutIndex(available, track.kind, final);
        if (cut <= 0) break;
        const usable = available.slice(0, cut);
        const following = remaining[cut];
        const span = spanOf(usable);

        // Matroska stores frames in decode order and stamps them with their
        // presentation time; MP4 wants decode times in tfdt and trun, with the
        // difference carried as a composition offset.
        const decodeTimes = usable
          .map((frame) => frame.timeMs)
          .sort((a, b) => a - b);
        const samples = usable.map((frame, index) => {
          const decode = decodeTimes[index]!;
          const next = decodeTimes[index + 1];
          const duration =
            next != null
              ? next - decode
              : following && following.timeMs > decode
                ? following.timeMs - decode
                : lastGap(decodeTimes);
          return {
            data: frame.data,
            durationTicks: Math.max(1, Math.round(duration)),
            keyframe: frame.keyframe,
            compositionOffsetTicks: Math.round(frame.timeMs - decode),
          };
        });
        const reordered = samples.some(
          (sample) => sample.compositionOffsetTicks !== 0,
        );
        built.push({
          startMs: decodeTimes[0]!,
          trackNumber,
          track,
          samples,
          endMs: decodeTimes.at(-1)!,
          spanMs: span,
          opensOnKeyframe: usable[0]!.keyframe,
          reordered,
        });
        this.startedTracks.add(trackNumber);
        remaining = remaining.slice(cut);
      }
      this.pending.set(trackNumber, final ? [] : remaining);
    }

    // Interleave audio and video by time. Appending an entire video track
    // before its audio leaves the muxed SourceBuffer with no playable range
    // and can hit quota while `buffered` still reports empty.
    built.sort((left, right) => left.startMs - right.startMs);
    for (const fragment of built) {
      // mfhd sequence_number describes fragment order, so assign it only
      // after the cross-track timestamp sort. Safari is stricter here than
      // Chromium even though both accept independently valid moof boxes.
      const segment = buildMediaSegment(
        this.sequence++,
        fragment.trackNumber,
        Math.round(fragment.startMs),
        fragment.samples,
      );
      this.lastSegment = `track ${fragment.trackNumber} ${fragment.track.kind} · ${fragment.samples.length} samples · ${(fragment.startMs / 1000).toFixed(2)}-${(fragment.endMs / 1000).toFixed(2)}s · ${fragment.opensOnKeyframe ? "opens on keyframe" : "MID-GOP"}${fragment.reordered ? " · reordered" : ""} · ${(segment.byteLength / 1024).toFixed(0)} KB`;
      if (fragment.track.kind === "video") {
        this.appendedBytes += segment.byteLength;
        this.appendedSeconds += fragment.spanMs / 1000;
      }
      this.enqueue(segment);
    }
  }

  private enqueue(segment: Uint8Array) {
    this.queue.push(segment);
    this.queuedBytes += segment.byteLength;
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
    // `endstreaming` asks the producer to stop fetching new data; it does not
    // make already-remuxed fragments disposable. Always drain this bounded
    // queue. Otherwise iOS asks us to pause at ~2 seconds and the very data
    // needed to advance beyond 2 seconds remains stranded in JavaScript.
    const next = this.queue.shift();
    if (!next) {
      if (this.eofPending) {
        this.eofPending = false;
        try {
          this.source.endOfStream();
          if (this.watchdog) window.clearInterval(this.watchdog);
          this.watchdog = 0;
          this.enter("ended");
          this.report({
            state: "ended",
            message: this.eofReason || "Reached the end of the file.",
            bufferedSeconds: this.bufferedAhead(),
            fetchedBytes: this.nextByte,
            ranges: this.describeRanges(),
          });
        } catch (error) {
          this.report({
            state: "error",
            message: `Could not finish the remux stream: ${describeError(error)}.`,
            ranges: this.describeRanges(),
            fetchedBytes: this.nextByte,
          });
        }
      } else {
        this.pumpNote = "queue empty";
      }
      return;
    }
    this.queuedBytes = Math.max(0, this.queuedBytes - next.byteLength);
    try {
      this.pumpNote = `appending ${(next.byteLength / 1024).toFixed(0)} KB`;
      buffer.appendBuffer(next as unknown as BufferSource);
    } catch (error) {
      // A quota error means eviction has to happen before this can retry.
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        this.queue.unshift(next);
        this.queuedBytes += next.byteLength;
        const freed = shouldManuallyEvict(
          this.managedMediaSource,
          true,
          true,
        )
          ? this.evict(true)
          : false;
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
    const minimum = this.managedMediaSource
      ? MANAGED_MIN_AHEAD_SECONDS
      : MIN_AHEAD_SECONDS;
    const maximum = this.managedMediaSource
      ? MANAGED_MAX_AHEAD_SECONDS
      : MAX_AHEAD_SECONDS;
    if (this.appendedSeconds < 2 || this.appendedBytes === 0) return maximum;
    const budget = this.managedMediaSource
      ? MANAGED_BUFFER_BUDGET_BYTES
      : this.budgetBytes();
    const affordable = budget / this.bytesPerSecond();
    return Math.max(minimum, Math.min(maximum, affordable));
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
  defaultDurationNs?: number;
}): TrackHeader {
  return {
    number: track.number,
    kind: track.kind as TrackHeader["kind"],
    codecId: track.codecId,
    codecPrivate: track.codecPrivate,
    defaultDurationNs: track.defaultDurationNs ?? null,
  };
}

const codecString = (track: MuxTrack) =>
  codecStringFor(track.sampleEntry, track.config);
