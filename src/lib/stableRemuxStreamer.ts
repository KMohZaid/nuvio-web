import type { Conversion, Input } from "mediabunny";
import type {
  RemuxStreamerOptions,
  StreamerStatus,
} from "./remuxStreamer";
import {
  remuxLanguageRoot,
  selectRemuxTrackPair,
} from "./remuxTrackSelection";

/**
 * Matroska -> fragmented MP4 playback for MSE/MMS.
 *
 * The first prototype in remuxStreamer.ts deliberately implemented the
 * container writer itself. That was useful for learning what these streams
 * contain, but Safari is much less forgiving than Chromium about decode-time
 * continuity across audio/video fragments. In particular, valid-looking
 * one-track moofs could append while the combined buffered range stayed at
 * the first fragment.
 *
 * This production path delegates Matroska parsing and ISO-BMFF writing to
 * Mediabunny. It emits multiplexed, keyframe-aligned fMP4 fragments and keeps
 * the conversion paused only a few seconds ahead of the playhead. Nothing is
 * decoded or re-encoded: compatible H.264/HEVC/AAC/AC-3/E-AC-3 packets are
 * copied into a browser-native MP4 stream.
 */

type MediaSourceConstructor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};

type ManagedMediaSourceLike = MediaSource & {
  addEventListener(
    type: "startstreaming" | "endstreaming",
    listener: EventListener,
  ): void;
  removeEventListener(
    type: "startstreaming" | "endstreaming",
    listener: EventListener,
  ): void;
};

type QueuedAppend = {
  bytes: Uint8Array<ArrayBuffer>;
  label: string;
};

const INITIAL_OUTPUT_SECONDS = 3;
const OUTPUT_STEP_SECONDS = 2;
const IOS_TARGET_AHEAD_SECONDS = 5;
const DESKTOP_TARGET_AHEAD_SECONDS = 12;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 12;
const SOURCE_CACHE_BYTES = 4 * 1024 * 1024;
const SOURCE_OPEN_TIMEOUT_MS = 15_000;
const KEEP_DESKTOP_HISTORY_SECONDS = 12;

function join(
  first: Uint8Array<ArrayBufferLike>,
  second: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  // Explicitly own one plain ArrayBuffer so appendBuffer can consume it
  // directly. A second same-sized copy is expensive enough to terminate an
  // iPhone WebContent process when a 4K source has long GOP fragments.
  const joined = new Uint8Array(
    new ArrayBuffer(first.byteLength + second.byteLength),
  );
  joined.set(first, 0);
  joined.set(second, first.byteLength);
  return joined;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Unknown media error");
}

function mediaErrorMessage(element: HTMLVideoElement) {
  const error = element.error;
  if (!error) return "The browser rejected the remuxed stream.";
  return error.message || `The browser rejected the stream (code ${error.code}).`;
}

function describeDiscarded(conversion: Conversion) {
  return conversion.discardedTracks
    .map(({ track, reason }) => `${track.type}: ${reason.replaceAll("_", " ")}`)
    .join(", ");
}

function sourceConstructor() {
  const managed = (
    window as unknown as { ManagedMediaSource?: MediaSourceConstructor }
  ).ManagedMediaSource;
  const standard = window.MediaSource as MediaSourceConstructor | undefined;
  return { Source: managed ?? standard, managed: Boolean(managed) };
}

async function fetchMediaRange(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status !== 416) return response;

  // A few signed media hosts reject every Range request even though the same
  // URL streams correctly as HTTP 200. UrlSource already has a bounded
  // sequential mode for a 200 response, so retry once without Range and let
  // it switch modes instead of surfacing the opaque "invalid byte range".
  const headers = new Headers(init?.headers);
  if (!headers.has("Range")) return response;
  headers.delete("Range");
  try {
    await response.body?.cancel();
  } catch {
    // The rejected response normally has no body.
  }
  return fetch(input, { ...init, headers });
}

export class StableRemuxStreamer {
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private input: Input | null = null;
  private conversion: Conversion | null = null;
  private objectUrl = "";
  private stopped = false;
  private failed = false;
  private managed = false;
  private managedWantsData = true;
  private triedPlay = false;
  private queue: QueuedAppend[] = [];
  private queuedBytes = 0;
  private ftyp: Uint8Array | null = null;
  private moov: Uint8Array | null = null;
  private initQueued = false;
  private pendingMoofs: Array<{ bytes: Uint8Array; timestamp: number }> = [];
  private mime = "";
  private readBytes = 0;
  private processedTime = 0;
  private fragmentCount = 0;
  private lastAppend = "nothing yet";
  private evicting = false;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly url: string,
    private readonly element: HTMLVideoElement,
    private readonly onStatus: (status: StreamerStatus) => void,
    private readonly options: RemuxStreamerOptions = {},
  ) {}

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.pendingMoofs = [];

    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Teardown must continue even when WebKit has already detached MMS.
      }
    }

    const conversion = this.conversion;
    this.conversion = null;
    if (conversion && conversion.state !== "done") {
      void conversion.cancel().catch(() => undefined);
    }
    this.input?.dispose();
    this.input = null;

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
    this.report("starting", "Inspecting Matroska tracks…");
    // The demuxer/muxer is sizeable and only needed for Matroska playback.
    // Keeping it out of the main bundle avoids slowing every normal PWA load.
    const mediaKitPromise = import("mediabunny");
    const { Source, managed } = sourceConstructor();
    if (!Source) {
      this.fail("Media Source playback is unavailable in this browser.");
      return;
    }
    this.managed = managed;

    // MMS on iPhone is exposed only when AirPlay has an alternate source or
    // remote playback is explicitly disabled. Nuvio uses the latter because
    // the object URL only exists inside this page.
    this.element.playsInline = true;
    this.element.disableRemotePlayback = true;

    const mediaSource = new Source();
    this.source = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.element.src = this.objectUrl;
    this.element.load();
    this.watchMediaElement();
    this.watchManagedDemand(mediaSource);
    const opened = this.waitForSourceOpen(mediaSource);
    // If track inspection fails before we reach `await opened`, sourceclose
    // must still count as handled instead of becoming an unhandled rejection
    // in Safari's page process.
    void opened.catch(() => undefined);

    const {
      Conversion: ConversionClass,
      Input: InputClass,
      MATROSKA,
      Mp4OutputFormat,
      NullTarget,
      Output,
      UrlSource,
    } = await mediaKitPromise;
    const urlSource = new UrlSource(this.url, {
      requestInit: {
        cache: "no-store",
        headers: this.options.requestHeaders,
      },
      maxCacheSize: SOURCE_CACHE_BYTES,
      parallelism: 1,
      fetchFn: fetchMediaRange,
      getRetryDelay: (attempt) => (attempt <= 3 ? 0.35 * 2 ** attempt : null),
    });
    urlSource.onread = (start, end) => {
      this.readBytes += Math.max(0, end - start);
    };
    const input = new InputClass({ source: urlSource, formats: [MATROSKA] });
    this.input = input;

    // A large release often puts TrueHD/DTS first and AAC/E-AC-3 second. The
    // old `primary` choice therefore rejected the whole source (or produced
    // silent video) even when a browser-compatible alternate track existed.
    // Inspect the small track header up front and pick exactly one compatible
    // video/audio pair, honoring the synced audio language when possible.
    const tracks = await input.getTracks();
    const primaryVideo = await input.getPrimaryVideoTrack();
    const primaryAudio = await input.getPrimaryAudioTrack();
    const trackInfo = await Promise.all(
      tracks.map(async (track) => ({
        track,
        codec: await track.getCodec(),
        language: remuxLanguageRoot(await track.getLanguageCode()),
        primary:
          track.id === primaryVideo?.id || track.id === primaryAudio?.id,
      })),
    );
    const { videoId, audioId } = selectRemuxTrackPair(
      trackInfo.map(({ track, codec, language, primary }) => ({
        id: track.id,
        type: track.type,
        codec,
        language,
        primary,
      })),
      this.options.preferredAudioLanguage,
      navigator.languages?.[0] || navigator.language,
    );

    if (videoId === null || audioId === null) {
      const found = trackInfo
        .map(({ track, codec }) => `${track.type}:${codec || "unknown"}`)
        .join(", ");
      this.fail(
        `This source has no browser-compatible video/audio pair (${found || "no tracks"}). Try an AAC/E-AC-3 source or an external player.`,
      );
      return;
    }

    let lastMoof: { bytes: Uint8Array; timestamp: number } | null = null;
    const format = new Mp4OutputFormat({
      fastStart: "fragmented",
      // Short fragments bound memory and let MMS begin after one keyframe.
      minimumFragmentDuration: 1,
      onFtyp: (bytes) => {
        if (this.stopped) return;
        this.ftyp = bytes.slice();
        this.maybeQueueInit();
      },
      onMoov: (bytes) => {
        if (this.stopped) return;
        this.moov = bytes.slice();
        this.maybeQueueInit();
      },
      onMoof: (bytes, _position, timestamp) => {
        if (this.stopped) return;
        lastMoof = { bytes: bytes.slice(), timestamp };
        this.pendingMoofs.push(lastMoof);
      },
      onMdat: (bytes) => {
        if (this.stopped) return;
        // The fragmented writer emits one mdat immediately after each moof.
        // Pairing the two into a single append also follows the ISO-BMFF MSE
        // media-segment definition exactly.
        const moof = this.pendingMoofs.shift() ?? lastMoof;
        lastMoof = null;
        if (!moof) {
          this.fail("The MP4 writer emitted media without a fragment header.");
          return;
        }
        this.fragmentCount += 1;
        this.enqueue(
          join(moof.bytes, bytes),
          `fragment ${this.fragmentCount} at ${moof.timestamp.toFixed(2)}s`,
        );
      },
    });
    const output = new Output({ format, target: new NullTarget() });

    let conversion: Conversion;
    try {
      conversion = await ConversionClass.init({
        input,
        output,
        tracks: "all",
        video: (track) => ({ discard: track.id !== videoId }),
        audio: (track) => ({ discard: track.id !== audioId }),
        showWarnings: false,
      });
    } catch (error) {
      this.fail(`Could not read this Matroska file: ${errorMessage(error)}`);
      return;
    }
    this.conversion = conversion;

    const hasVideo = conversion.utilizedTracks.some((track) => track.type === "video");
    const hasAudio = conversion.utilizedTracks.some((track) => track.type === "audio");
    if (!conversion.isValid || !hasVideo || !hasAudio) {
      const discarded = describeDiscarded(conversion);
      this.fail(
        discarded
          ? `This source cannot be remuxed without transcoding (${discarded}). Try an AAC/E-AC-3 source or an external player.`
          : "This source does not contain a compatible video and audio pair.",
      );
      return;
    }

    conversion.onProgress = (_ratio, processedTime) => {
      this.processedTime = Math.max(this.processedTime, processedTime);
    };

    try {
      // Producing the first tiny window discovers the exact codec strings and
      // emits ftyp/moov. It is deliberately bounded; the old path could read
      // tens of megabytes before Safari had accepted a single segment.
      await conversion.execute({ until: INITIAL_OUTPUT_SECONDS });
      if (this.stopped) return;
      this.mime = await output.getMimeType();
      await opened;
      if (this.stopped) return;
      if (mediaSource.readyState !== "open") {
        throw new Error("Media Source closed before its buffer was ready.");
      }
      if (!Source.isTypeSupported(this.mime)) {
        throw new Error(`Safari does not support ${this.mime}.`);
      }

      const sourceBuffer = mediaSource.addSourceBuffer(this.mime);
      sourceBuffer.mode = "segments";
      this.buffer = sourceBuffer;
      this.watchSourceBuffer(sourceBuffer);
      const duration = await input
        .getDurationFromMetadata(conversion.utilizedTracks)
        .catch(() => null);
      if (duration && Number.isFinite(duration)) {
        try {
          mediaSource.duration = duration;
        } catch {
          // Duration is cosmetic; an MMS implementation may own it.
        }
      }
      this.pump();
      this.report("buffering", "Preparing the first playable fragment…");
      void this.fillLoop();
    } catch (error) {
      this.fail(`The browser could not start the remuxed stream: ${errorMessage(error)}`);
    }
  }

  private maybeQueueInit() {
    if (this.initQueued || !this.ftyp || !this.moov) return;
    this.initQueued = true;
    this.enqueue(join(this.ftyp, this.moov), "initialization segment");
    this.ftyp = null;
    this.moov = null;
  }

  private enqueue(bytes: Uint8Array<ArrayBuffer>, label: string) {
    if (this.stopped || this.failed) return;
    this.queue.push({ bytes, label });
    this.queuedBytes += bytes.byteLength;
    this.pump();
  }

  private pump() {
    if (
      this.stopped ||
      this.failed ||
      !this.buffer ||
      !this.source ||
      this.source.readyState !== "open" ||
      this.buffer.updating ||
      this.evicting
    ) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.tryPlay();
      return;
    }
    this.queuedBytes -= next.bytes.byteLength;
    this.lastAppend = `${next.label} (${(next.bytes.byteLength / 1024).toFixed(0)} KB)`;
    try {
      this.buffer.appendBuffer(next.bytes);
    } catch (error) {
      this.queue.unshift(next);
      this.queuedBytes += next.bytes.byteLength;
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        if (!this.removeOldBuffer(true)) {
          window.setTimeout(() => this.pump(), 300);
        }
        return;
      }
      this.fail(
        `Safari rejected ${this.lastAppend}: ${errorMessage(error)} · ${this.rangeDescription()}`,
      );
    }
  }

  private watchSourceBuffer(buffer: SourceBuffer) {
    const onUpdateEnd = () => {
      this.evicting = false;
      this.tryPlay();
      const ahead = this.bufferedAhead();
      this.report(
        ahead >= 0.75 ? "ready" : "buffering",
        ahead >= 0.75
          ? `Remux ready · ${ahead.toFixed(1)}s buffered`
          : "Waiting for matching audio and video data…",
      );
      this.pump();
    };
    const onError = () => {
      this.fail(
        `Safari rejected ${this.lastAppend} · ${mediaErrorMessage(this.element)} · ${this.rangeDescription()}`,
      );
    };
    buffer.addEventListener("updateend", onUpdateEnd);
    buffer.addEventListener("error", onError);
    this.cleanups.push(() => {
      buffer.removeEventListener("updateend", onUpdateEnd);
      buffer.removeEventListener("error", onError);
    });
  }

  private watchMediaElement() {
    const onError = () => this.fail(mediaErrorMessage(this.element));
    const onPlaying = () =>
      this.report("ready", `Playing · ${this.bufferedAhead().toFixed(1)}s buffered`);
    this.element.addEventListener("error", onError);
    this.element.addEventListener("playing", onPlaying);
    this.cleanups.push(() => {
      this.element.removeEventListener("error", onError);
      this.element.removeEventListener("playing", onPlaying);
    });
  }

  private watchManagedDemand(source: MediaSource) {
    if (!this.managed) return;
    const managed = source as ManagedMediaSourceLike;
    const onStart: EventListener = () => {
      this.managedWantsData = true;
    };
    const onEnd: EventListener = () => {
      this.managedWantsData = false;
    };
    managed.addEventListener("startstreaming", onStart);
    managed.addEventListener("endstreaming", onEnd);
    this.cleanups.push(() => {
      managed.removeEventListener("startstreaming", onStart);
      managed.removeEventListener("endstreaming", onEnd);
    });
  }

  private waitForSourceOpen(source: MediaSource) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        source.removeEventListener("sourceopen", onOpen);
        source.removeEventListener("sourceclose", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onClose = () => finish(new Error("Media Source closed while opening."));
      const timeout = window.setTimeout(
        () => finish(new Error("Media Source did not open on this device.")),
        SOURCE_OPEN_TIMEOUT_MS,
      );
      source.addEventListener("sourceopen", onOpen, { once: true });
      source.addEventListener("sourceclose", onClose, { once: true });
      this.cleanups.push(() => finish(new Error("Playback was closed.")));
    });
  }

  private async fillLoop() {
    const conversion = this.conversion;
    if (!conversion) return;
    try {
      while (!this.stopped && !this.failed && conversion.state !== "done") {
        this.pump();
        const ahead = this.bufferedAhead();
        const queueFull =
          this.queuedBytes >= MAX_QUEUE_BYTES ||
          this.queue.length >= MAX_QUEUE_ITEMS;
        const demandPaused = this.managed && !this.managedWantsData && ahead >= 1;
        if (ahead >= this.targetAhead() || queueFull || demandPaused) {
          this.removeOldBuffer(false);
          await this.wait(160);
          continue;
        }

        const target = Math.max(
          this.processedTime + OUTPUT_STEP_SECONDS,
          this.element.currentTime + this.targetAhead(),
        );
        this.report(
          ahead > 0 ? "ready" : "buffering",
          `Remuxing · ${ahead.toFixed(1)}s buffered · ${(this.readBytes / 1024 / 1024).toFixed(1)} MB read`,
        );
        await conversion.execute({ until: target });
        // Let SourceBuffer dispatch updateend before producing another window.
        await this.wait(0);
      }

      if (this.stopped || this.failed) return;
      while (this.queue.length || this.buffer?.updating) {
        this.pump();
        await this.wait(50);
      }
      if (this.source?.readyState === "open") {
        try {
          this.source.endOfStream();
        } catch {
          // MMS may have detached after its final bufferedchange.
        }
      }
      this.report("ended", "The complete stream is buffered.");
    } catch (error) {
      if (this.stopped) return;
      this.fail(
        `Remuxing stopped at ${this.processedTime.toFixed(1)}s: ${errorMessage(error)}. Try another source or an external player.`,
      );
    }
  }

  private targetAhead() {
    return this.managed ? IOS_TARGET_AHEAD_SECONDS : DESKTOP_TARGET_AHEAD_SECONDS;
  }

  private bufferedAhead() {
    try {
      const ranges = this.buffer?.buffered;
      if (!ranges?.length) return 0;
      const now = this.element.currentTime || 0;
      for (let index = 0; index < ranges.length; index += 1) {
        const start = ranges.start(index);
        const end = ranges.end(index);
        // Safari sometimes reports the first range a few milliseconds after 0.
        if (now >= start - 0.25 && now <= end) return Math.max(0, end - now);
      }
    } catch {
      // A detached SourceBuffer throws while WebKit is tearing MMS down.
    }
    return 0;
  }

  private rangeDescription() {
    try {
      const ranges = this.buffer?.buffered;
      if (!ranges?.length) return "buffer empty";
      const values: string[] = [];
      for (let index = 0; index < ranges.length; index += 1) {
        values.push(`${ranges.start(index).toFixed(2)}-${ranges.end(index).toFixed(2)}s`);
      }
      return `buffer ${values.join(", ")}`;
    } catch {
      return "buffer detached";
    }
  }

  private removeOldBuffer(force: boolean) {
    if (!this.buffer || this.buffer.updating || this.evicting) return false;
    if (this.managed && !force) return false;
    const removeEnd = this.element.currentTime - KEEP_DESKTOP_HISTORY_SECONDS;
    if (removeEnd <= 0) return false;
    try {
      this.evicting = true;
      this.buffer.remove(0, removeEnd);
      return true;
    } catch {
      this.evicting = false;
      return false;
    }
  }

  private tryPlay() {
    if (this.triedPlay || this.bufferedAhead() < 0.75) return;
    this.triedPlay = true;
    void this.element.play().catch(() => {
      // Losing the original user gesture while the first fragment is built is
      // normal on iOS; the visible play button remains available.
    });
  }

  private report(state: StreamerStatus["state"], message: string) {
    if (this.stopped || (this.failed && state !== "error")) return;
    this.onStatus({
      state,
      message,
      bufferedSeconds: this.bufferedAhead(),
      fetchedBytes: this.readBytes,
      ranges: this.rangeDescription(),
    });
  }

  private fail(message: string) {
    if (this.stopped || this.failed) return;
    this.failed = true;
    this.report("error", message);
  }

  private wait(milliseconds: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
  }
}
