import type { Conversion, Input } from "mediabunny";
import type {
  RemuxStreamerOptions,
  StreamerStatus,
} from "./remuxStreamer";
import {
  remuxLanguageRoot,
  selectBrowserRemuxPlan,
} from "./remuxTrackSelection";
import { shouldReportFragmentAppendStall } from "./remuxBufferPolicy";
import {
  fetchMediaRange,
  type RangeCapability,
  type RangeFetchState,
} from "./rangeFetch";

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
 * the conversion paused only a few seconds ahead of the playhead. Compatible
 * H.264/HEVC and AAC packets are copied into a browser-native MP4 stream. When
 * the only usable audio is AC-3/E-AC-3, that audio alone is converted to AAC
 * in-browser; the video is still copied without re-encoding.
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
  generation: number;
};

const INITIAL_OUTPUT_SECONDS = 3;
const OUTPUT_STEP_SECONDS = 2;
const IOS_TARGET_AHEAD_SECONDS = 5;
const DESKTOP_TARGET_AHEAD_SECONDS = 12;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024;
const MAX_QUEUE_ITEMS = 12;
const SOURCE_CACHE_BYTES = 12 * 1024 * 1024;
const SOURCE_OPEN_TIMEOUT_MS = 15_000;
const SOURCE_INSPECTION_TIMEOUT_MS = 60_000;
const CONVERSION_STEP_TIMEOUT_MS = 45_000;
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

/**
 * Rewrites a hev1./hvc1. codec-parameter prefix to match whichever of the
 * two sample entry fourCCs the moov actually contains.
 *
 * Mediabunny's HEVC sample entry box is always named hvc1 (its box writer
 * hardcodes that fourCC), but its codec-string builder always starts the
 * parameter with hev1. — the two disagree unconditionally, not depending on
 * the stream. A SourceBuffer opened with a codec string whose prefix doesn't
 * match the box it's about to receive is rejected outright, so the string is
 * corrected here rather than trusted as given.
 */
function normalizeHevcMimePrefix(mime: string, boxEntries?: string[]): string {
  if (!mime) return mime;
  // Without the moov to read, hvc1 is the safe assumption: it is the only
  // HEVC box name this writer produces.
  const hev1 = boxEntries?.includes("hev1") && !boxEntries.includes("hvc1");
  if (hev1) return mime.replaceAll("hvc1.", "hev1.");
  return mime.replaceAll("hev1.", "hvc1.");
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

function combinedAbortSignal(...signals: Array<AbortSignal | null | undefined>) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length <= 1) return active[0];
  const AbortSignalWithAny = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (AbortSignalWithAny.any) return AbortSignalWithAny.any(active);

  // Safari versions predating AbortSignal.any still need both the UrlSource
  // worker cancellation and the player-wide teardown signal.
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export class StableRemuxStreamer {
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private input: Input | null = null;
  private seekInput: Input | null = null;
  private conversion: Conversion | null = null;
  /** A new generation is created whenever an unbuffered seek restarts conversion. */
  private conversionGeneration = 0;
  /** Absolute presentation time represented by timestamp zero in the active conversion. */
  private outputStart = 0;
  private restartConversion: ((startSeconds: number) => Promise<void>) | null = null;
  private rangeCapability: RangeCapability = "unknown";
  private durationSeconds = 0;
  private objectUrl = "";
  private stopped = false;
  private failed = false;
  private managed = false;
  private managedWantsData = true;
  private triedPlay = false;
  private queue: QueuedAppend[] = [];
  private queuedBytes = 0;
  private mime = "";
  private readBytes = 0;
  private processedTime = 0;
  private fragmentCount = 0;
  private lastAppend = "nothing yet";
  /** What the init segment declared, so a rejection can say what was rejected. */
  private initSummary = "";
  /** The output's real MIME, learnt after the moov and applied before appending. */
  private pendingMime = "";
  private evicting = false;
  private appendedMediaSegments = 0;
  private segmentsAtLastProgress = 0;
  private lastBufferedEnd = 0;
  private readonly abortController = new AbortController();
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
    this.abortController.abort();
    this.queue = [];
    this.queuedBytes = 0;
    this.conversionGeneration += 1;
    this.restartConversion = null;

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
    this.seekInput?.dispose();
    this.seekInput = null;

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

  /**
   * Seeks a remuxed file without pretending the sequential output is a native
   * random-access stream. Buffered targets are immediate. For an unbuffered
   * target, a range-capable source starts a fresh conversion at the nearest
   * Matroska cue and appends it at the requested presentation timestamp.
   */
  async seek(targetSeconds: number) {
    const duration = this.durationSeconds || this.element.duration;
    const target = Math.max(
      0,
      Math.min(
        Number.isFinite(duration) && duration > 0 ? duration - 0.05 : targetSeconds,
        targetSeconds,
      ),
    );
    if (!Number.isFinite(target)) return false;
    if (this.isBuffered(target)) {
      this.element.currentTime = target;
      return true;
    }
    if (this.rangeCapability !== "range" || !this.restartConversion) {
      this.report(
        "ready",
        this.rangeCapability === "sequential"
          ? "This media host does not support byte-range seeking; only buffered playback can be scrubbed."
          : "The source is not ready for random seeking yet.",
      );
      return false;
    }
    try {
      await this.restartConversion(target);
      return true;
    } catch (error) {
      if (!this.stopped)
        this.fail(`Could not seek to ${target.toFixed(1)}s: ${errorMessage(error)}`);
      return false;
    }
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
      Source: ByteSource,
      UrlSource,
      canEncodeAudio,
    } = await mediaKitPromise;
    const rangeFetchState: RangeFetchState = { resolvedUrl: null };
    const makeUrlSource = () => {
      const source = new UrlSource(this.url, {
        requestInit: {
          cache: "no-store",
          headers: this.options.requestHeaders,
        },
        maxCacheSize: SOURCE_CACHE_BYTES,
        parallelism: 1,
        fetchFn: (resource, init) =>
          fetchMediaRange(
            resource,
            {
              ...init,
              signal: combinedAbortSignal(
                init?.signal,
                this.abortController.signal,
              ),
            },
            rangeFetchState,
            (capability) => {
              // Once a host has fallen back to one sequential HTTP 200
              // response, later requests cannot make random access safe.
              if (this.rangeCapability !== "sequential")
                this.rangeCapability = capability;
            },
          ),
        getRetryDelay: (attempt) =>
          attempt <= 3 ? 0.35 * 2 ** attempt : null,
      });
      source.onread = (start, end) => {
        this.readBytes += Math.max(0, end - start);
      };
      return source;
    };

    const initialUrlSource = makeUrlSource();
    type InternalSourceRead = {
      bytes: Uint8Array;
      view: DataView;
      offset: number;
    };
    const initialDelegate = initialUrlSource as unknown as {
      _read(
        start: number,
        end: number,
        minimum: number,
        maximum: number,
      ): InternalSourceRead | null | Promise<InternalSourceRead | null>;
      _dispose(): void;
    };
    // WebKit's ManagedMediaSource does not need the complete Matroska Cues
    // table to start playing. Presenting the initial source as unsized makes
    // the demuxer stop metadata inspection at the first Cluster rather than
    // following a far-away/large Cues entry before it returns Tracks. The
    // delegate remains range-backed; a separate sized Input is created lazily
    // only when the user requests an unbuffered seek.
    class InitialPlaybackSource extends ByteSource {
      _getFileSize() {
        return null;
      }

      _read(
        start: number,
        end: number,
        minimum: number,
        maximum: number,
      ) {
        return initialDelegate._read(start, end, minimum, maximum);
      }

      _dispose() {
        initialDelegate._dispose();
      }
    }
    const initialSource = managed
      ? new InitialPlaybackSource()
      : initialUrlSource;
    const input = new InputClass({ source: initialSource, formats: [MATROSKA] });
    this.input = input;
    const indexedInput = async () => {
      if (this.seekInput) return this.seekInput;
      const next = new InputClass({
        source: makeUrlSource(),
        formats: [MATROSKA],
      });
      // Force the seek table to load while the UI says "Seeking" rather than
      // making every Safari startup pay this cost.
      await this.withTimeout(
        next.getTracks(),
        SOURCE_INSPECTION_TIMEOUT_MS * 2,
        "The Matroska seek index could not be loaded in time.",
      );
      this.seekInput = next;
      return next;
    };

    // A large release often puts TrueHD/DTS first and AAC/E-AC-3 second. The
    // old `primary` choice therefore rejected the whole source (or produced
    // silent video) even when a browser-compatible alternate track existed.
    // Inspect the small track header up front and pick exactly one compatible
    // video/audio pair, honoring the synced audio language when possible.
    const tracks = await this.withTimeout(
      input.getTracks(),
      SOURCE_INSPECTION_TIMEOUT_MS,
      `The media host did not return the Matroska track headers within ${SOURCE_INSPECTION_TIMEOUT_MS / 1000}s (${(this.readBytes / 1024 / 1024).toFixed(1)} MB read, ${this.rangeCapability} access).`,
    );
    const [primaryVideo, primaryAudio] = await this.withTimeout(
      Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]),
      SOURCE_INSPECTION_TIMEOUT_MS,
      "The media host stalled while the primary tracks were being read.",
    );
    const trackInfo = await this.withTimeout(
      Promise.all(
        tracks.map(async (track) => ({
          track,
          codec: await track.getCodec(),
          codecParameter: await track.getCodecParameterString(),
          language: remuxLanguageRoot(await track.getLanguageCode()),
          primary:
            track.id === primaryVideo?.id || track.id === primaryAudio?.id,
        })),
      ),
      SOURCE_INSPECTION_TIMEOUT_MS,
      "The media host stalled while the codec information was being read.",
    );
    const { videoId, audioId, transcodeAudio, mime: plannedMime } =
      selectBrowserRemuxPlan(
        trackInfo.map(
          ({ track, codec, codecParameter, language, primary }) => ({
            id: track.id,
            type: track.type,
            codec,
            codecParameter,
            language,
            primary,
          }),
        ),
        this.options.preferredAudioLanguage,
        navigator.languages?.[0] || navigator.language,
        (mime) => Source.isTypeSupported(mime),
      );

    if (videoId === null || audioId === null) {
      const found = trackInfo
        .map(({ track, codec }) => `${track.type}:${codec || "unknown"}`)
        .join(", ");
      this.fail(
        `This source has no browser-compatible video/audio pair (${found || "no tracks"}). Try an H.264/HEVC source with AAC or Dolby audio, or use an external player.`,
      );
      return;
    }

    if (transcodeAudio) {
      this.report("starting", "Preparing Dolby audio conversion to AAC…");
      const [{ registerAc3Decoder }, aacEncoder] = await Promise.all([
        import("@mediabunny/ac3"),
        canEncodeAudio("aac", {
          numberOfChannels: 2,
          sampleRate: 48_000,
        }).then(async (supported) =>
          supported ? null : import("@mediabunny/aac-encoder"),
        ),
      ]);
      registerAc3Decoder();
      aacEncoder?.registerAacEncoder();
    }

    const buildConversion = async (
      startSeconds: number,
      generation: number,
      conversionInput: Input = input,
    ) => {
      let ftyp: Uint8Array | null = null;
      let moov: Uint8Array | null = null;
      let initQueued = false;
      let lastMoof: { bytes: Uint8Array; timestamp: number } | null = null;
      const pendingMoofs: Array<{ bytes: Uint8Array; timestamp: number }> = [];
      const maybeQueueInit = async () => {
        if (initQueued || !ftyp || !moov) return;
        initQueued = true;
        // getMimeType() before the conversion runs reports the source's codecs,
        // not the output's. When the video is transcoded — HEVC in, H.264 out —
        // that opens the SourceBuffer expecting hev1 and then hands it avc1,
        // which the browser rejects outright. Asking again now that the moov
        // exists gets what was actually written.
        const realMime = await output.getMimeType().catch(() => this.mime);
        // A rejected init segment nearly always means the sample entries in
        // the moov disagree with the MIME the SourceBuffer was opened with.
        // Both are printed so the mismatch is visible rather than inferred.
        const text = new TextDecoder("latin1").decode(moov);
        const entries = [
          "avc1", "avc3", "hvc1", "hev1", "av01", "vp09",
          "mp4a", "ac-3", "ec-3", "Opus", "fLaC",
        ].filter((code) => text.includes(code));
        // mediabunny's HEVC sample entry is always written as hvc1 (see
        // videoCodecToBoxName in its isobmff-boxes module), but its codec
        // string builder always emits a hev1. prefix regardless — the two
        // disagree by construction, not because of anything on our end. The
        // box bytes are ground truth, so the codec string is rewritten to
        // match whichever of hvc1/hev1 the moov actually contains.
        const normalizedMime = normalizeHevcMimePrefix(realMime, entries);
        if (normalizedMime && normalizedMime !== this.mime)
          this.pendingMime = normalizedMime;
        // Kept on the instance so a failure can say what it was carrying,
        // rather than leaving the reason in a console nobody is watching.
        this.initSummary = `${entries.join("+") || "no sample entries"} as ${
          this.mime || plannedMime || "unknown mime"
        }${transcodeAudio ? ", audio converted to AAC" : ""}`;
        console.info("[nuvio remux] init segment", {
          bytes: ftyp.byteLength + moov.byteLength,
          sampleEntries: entries,
          declaredMime: this.mime,
          plannedMime,
          transcodeAudio,
        });
        this.enqueue(join(ftyp, moov), "initialization segment", generation);
        ftyp = null;
        moov = null;
      };
      const format = new Mp4OutputFormat({
        fastStart: "fragmented",
        // Short fragments bound memory and let MMS begin after one keyframe.
        minimumFragmentDuration: 1,
        onFtyp: (bytes) => {
          if (this.stopped || generation !== this.conversionGeneration) return;
          ftyp = bytes.slice();
          void maybeQueueInit();
        },
        onMoov: (bytes) => {
          if (this.stopped || generation !== this.conversionGeneration) return;
          moov = bytes.slice();
          void maybeQueueInit();
        },
        onMoof: (bytes, _position, timestamp) => {
          if (this.stopped || generation !== this.conversionGeneration) return;
          lastMoof = { bytes: bytes.slice(), timestamp };
          pendingMoofs.push(lastMoof);
        },
        onMdat: (bytes) => {
          if (this.stopped || generation !== this.conversionGeneration) return;
          // The fragmented writer emits one mdat immediately after each moof.
          // Pairing the two into a single append follows the ISO-BMFF MSE
          // media-segment definition exactly.
          const moof = pendingMoofs.shift() ?? lastMoof;
          lastMoof = null;
          if (!moof) {
            this.fail("The MP4 writer emitted media without a fragment header.");
            return;
          }
          this.fragmentCount += 1;
          this.enqueue(
            join(moof.bytes, bytes),
            `fragment ${this.fragmentCount} at ${(startSeconds + moof.timestamp).toFixed(2)}s`,
            generation,
          );
        },
      });
      const output = new Output({ format, target: new NullTarget() });
      const conversion = await ConversionClass.init({
        input: conversionInput,
        output,
        tracks: "all",
        video: (track) => ({ discard: track.id !== videoId }),
        audio: (track) =>
          track.id !== audioId
            ? { discard: true }
            : transcodeAudio
              ? {
                  codec: "aac",
                  forceTranscode: true,
                  numberOfChannels: 2,
                  sampleRate: 48_000,
                }
              : {},
        trim: startSeconds > 0 ? { start: startSeconds } : undefined,
        showWarnings: false,
      });

      const hasVideo = conversion.utilizedTracks.some(
        (track) => track.type === "video",
      );
      const hasAudio = conversion.utilizedTracks.some(
        (track) => track.type === "audio",
      );
      if (!conversion.isValid || !hasVideo || !hasAudio) {
        const discarded = describeDiscarded(conversion);
        throw new Error(
          discarded
            ? `This source could not be prepared (${discarded}).`
            : "This source does not contain a compatible video and audio pair.",
        );
      }
      conversion.onProgress = (_ratio, processedTime) => {
        if (generation !== this.conversionGeneration) return;
        this.processedTime = Math.max(this.processedTime, processedTime);
      };
      await this.withTimeout(
        conversion.execute({ until: INITIAL_OUTPUT_SECONDS }),
        CONVERSION_STEP_TIMEOUT_MS,
        "The first playable segment could not be prepared in time.",
      );
      return { conversion, output };
    };

    const initialGeneration = ++this.conversionGeneration;
    let conversion: Conversion;
    let output: InstanceType<typeof Output>;
    try {
      const built = await buildConversion(0, initialGeneration);
      conversion = built.conversion;
      output = built.output;
    } catch (error) {
      this.fail(`Could not read this Matroska file: ${errorMessage(error)}`);
      return;
    }
    this.conversion = conversion;

    try {
      if (this.stopped) return;
      this.mime = normalizeHevcMimePrefix(await output.getMimeType());
      await opened;
      if (this.stopped) return;
      if (mediaSource.readyState !== "open") {
        throw new Error("Media Source closed before its buffer was ready.");
      }
      if (!Source.isTypeSupported(this.mime)) {
        throw new Error(
          `This browser does not support ${this.mime} (planned ${plannedMime || "unknown"}).`,
        );
      }

      const sourceBuffer = mediaSource.addSourceBuffer(this.mime);
      sourceBuffer.mode = "segments";
      this.buffer = sourceBuffer;
      this.watchSourceBuffer(sourceBuffer);
      const duration = await input
        .getDurationFromMetadata(conversion.utilizedTracks)
        .catch(() => null);
      const durationHint = this.options.durationHintSeconds;
      const stableDuration =
        duration && Number.isFinite(duration) && duration > 0
          ? duration
          : durationHint && Number.isFinite(durationHint) && durationHint > 0
            ? durationHint
            : null;
      if (stableDuration) {
        this.durationSeconds = stableDuration;
        try {
          mediaSource.duration = stableDuration;
        } catch {
          // ManagedMediaSource implementations may own the duration.
        }
      }
      this.restartConversion = async (startSeconds: number) => {
        const sourceBuffer = this.buffer;
        if (!sourceBuffer || !this.source || this.source.readyState !== "open")
          throw new Error("The media buffer is no longer available.");

        const generation = ++this.conversionGeneration;
        const previous = this.conversion;
        this.conversion = null;
        if (previous && previous.state !== "done")
          await previous.cancel().catch(() => undefined);
        if (this.stopped || generation !== this.conversionGeneration) return;

        await this.waitForBufferIdle(sourceBuffer);
        if (this.stopped || generation !== this.conversionGeneration) return;
        this.queue = [];
        this.queuedBytes = 0;
        this.evicting = false;
        this.processedTime = 0;
        this.outputStart = startSeconds;
        this.segmentsAtLastProgress = this.appendedMediaSegments;
        try {
          sourceBuffer.abort();
        } catch {
          // ManagedSourceBuffer may already have reset its parser state.
        }
        if (sourceBuffer.buffered.length) {
          const finalRange = sourceBuffer.buffered.end(
            sourceBuffer.buffered.length - 1,
          );
          sourceBuffer.remove(
            0,
            Math.max(finalRange, this.durationSeconds || finalRange),
          );
          await this.waitForBufferIdle(sourceBuffer);
        }
        this.lastBufferedEnd = 0;
        sourceBuffer.timestampOffset = startSeconds;

        this.report("buffering", `Seeking to ${startSeconds.toFixed(0)}s…`);
        const conversionInput = managed ? await indexedInput() : input;
        const built = await buildConversion(
          startSeconds,
          generation,
          conversionInput,
        );
        if (this.stopped || generation !== this.conversionGeneration) {
          if (built.conversion.state !== "done")
            await built.conversion.cancel().catch(() => undefined);
          return;
        }
        const nextMime = normalizeHevcMimePrefix(await built.output.getMimeType());
        if (nextMime !== this.mime)
          throw new Error(`The stream changed codec while seeking (${nextMime}).`);
        this.conversion = built.conversion;
        this.element.currentTime = startSeconds;
        this.pump();
        void this.fillLoop(built.conversion, generation, startSeconds);
      };
      this.pump();
      this.report("buffering", "Preparing the first playable fragment…");
      void this.fillLoop(conversion, initialGeneration, 0);
    } catch (error) {
      this.fail(`The browser could not start the remuxed stream: ${errorMessage(error)}`);
    }
  }

  private enqueue(
    bytes: Uint8Array<ArrayBuffer>,
    label: string,
    generation = this.conversionGeneration,
  ) {
    if (
      this.stopped ||
      this.failed ||
      generation !== this.conversionGeneration
    )
      return;
    this.queue.push({ bytes, label, generation });
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
    if (next.generation !== this.conversionGeneration) {
      this.queuedBytes = Math.max(0, this.queuedBytes - next.bytes.byteLength);
      this.pump();
      return;
    }
    this.queuedBytes -= next.bytes.byteLength;
    // The output's real codecs are only known once it has written a moov, so
    // the buffer is retyped to match rather than left expecting the source's.
    if (this.pendingMime && this.pendingMime !== this.mime) {
      const target = this.pendingMime;
      this.pendingMime = "";
      try {
        this.buffer.changeType(target);
        this.mime = target;
      } catch (error) {
        this.fail(
          `The stream is ${target} but this browser will not switch to it: ${errorMessage(error)}`,
        );
        return;
      }
    }
    this.lastAppend = `${next.label} (${(next.bytes.byteLength / 1024).toFixed(0)} KB)`;
    if (next.label.startsWith("fragment ")) this.appendedMediaSegments += 1;
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
        `The browser rejected ${this.lastAppend}: ${errorMessage(error)}` +
          `${this.initSummary ? ` · stream was ${this.initSummary}` : ""}` +
          ` · ${this.rangeDescription()}`,
      );
    }
  }

  private watchSourceBuffer(buffer: SourceBuffer) {
    const onUpdateEnd = () => {
      this.evicting = false;
      const bufferedEnd = this.bufferedEnd();
      if (bufferedEnd > this.lastBufferedEnd + 0.05) {
        this.lastBufferedEnd = bufferedEnd;
        this.segmentsAtLastProgress = this.appendedMediaSegments;
      } else if (
        shouldReportFragmentAppendStall(
          this.appendedMediaSegments,
          this.segmentsAtLastProgress,
          bufferedEnd,
          this.lastBufferedEnd,
        )
      ) {
        this.fail(
          `The browser accepted ${this.appendedMediaSegments} MP4 fragments but did not expose playable audio/video (${this.mime || "codec unknown"}). Try another source or an external player.`,
        );
        return;
      }
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
        `The browser rejected ${this.lastAppend} · ${mediaErrorMessage(this.element)}` +
          `${this.initSummary ? ` · stream was ${this.initSummary}` : ""}` +
          ` · ${this.rangeDescription()}`,
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
    const onError = () =>
      this.fail(
        `${mediaErrorMessage(this.element)}${
          this.initSummary ? ` · stream was ${this.initSummary}` : ""
        }`,
      );
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

  private async fillLoop(
    conversion: Conversion,
    generation: number,
    outputStart: number,
  ) {
    try {
      while (
        !this.stopped &&
        !this.failed &&
        generation === this.conversionGeneration &&
        this.conversion === conversion &&
        conversion.state !== "done"
      ) {
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
          Math.max(0, this.element.currentTime - outputStart) +
            this.targetAhead(),
        );
        this.report(
          ahead > 0 ? "ready" : "buffering",
          `Remuxing · ${ahead.toFixed(1)}s buffered · ${(this.readBytes / 1024 / 1024).toFixed(1)} MB read`,
        );
        await this.withTimeout(
          conversion.execute({ until: target }),
          CONVERSION_STEP_TIMEOUT_MS,
          `The media host stalled while preparing playback near ${target.toFixed(0)} seconds.`,
        );
        // Let SourceBuffer dispatch updateend before producing another window.
        await this.wait(0);
      }

      if (
        this.stopped ||
        this.failed ||
        generation !== this.conversionGeneration ||
        this.conversion !== conversion
      )
        return;
      while (
        generation === this.conversionGeneration &&
        (this.queue.some((item) => item.generation === generation) ||
          this.buffer?.updating)
      ) {
        this.pump();
        await this.wait(50);
      }
      if (generation !== this.conversionGeneration) return;
      if (this.source?.readyState === "open") {
        try {
          this.source.endOfStream();
        } catch {
          // MMS may have detached after its final bufferedchange.
        }
      }
      this.report("ended", "The complete stream is buffered.");
    } catch (error) {
      if (this.stopped || generation !== this.conversionGeneration) return;
      this.fail(
        `Remuxing stopped at ${(outputStart + this.processedTime).toFixed(1)}s: ${errorMessage(error)}. Try another source or an external player.`,
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

  private bufferedEnd() {
    try {
      const ranges = this.buffer?.buffered;
      if (!ranges?.length) return 0;
      let end = 0;
      for (let index = 0; index < ranges.length; index += 1) {
        end = Math.max(end, ranges.end(index));
      }
      return end;
    } catch {
      return 0;
    }
  }

  private isBuffered(targetSeconds: number) {
    try {
      const ranges = this.buffer?.buffered;
      if (!ranges?.length) return false;
      for (let index = 0; index < ranges.length; index += 1) {
        if (
          targetSeconds >= ranges.start(index) - 0.05 &&
          targetSeconds <= ranges.end(index) - 0.05
        )
          return true;
      }
    } catch {
      // A detached SourceBuffer is never seekable.
    }
    return false;
  }

  private async waitForBufferIdle(buffer: SourceBuffer) {
    const startedAt = performance.now();
    while (buffer.updating) {
      if (this.stopped) throw new Error("Playback was closed.");
      if (performance.now() - startedAt >= SOURCE_OPEN_TIMEOUT_MS)
        throw new Error("The browser did not finish its previous media append.");
      await this.wait(25);
    }
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
    this.abortController.abort();
    const conversion = this.conversion;
    if (conversion && conversion.state !== "done") {
      void conversion.cancel().catch(() => undefined);
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    message: string,
  ) {
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.abortController.abort();
        reject(new Error(message));
      }, milliseconds);
      promise.then(
        (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private wait(milliseconds: number) {
    return new Promise<void>((resolve) =>
      window.setTimeout(resolve, milliseconds),
    );
  }
}
