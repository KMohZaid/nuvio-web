import {
  ALL_FORMATS,
  AudioBufferSink,
  CanvasSink,
  Input,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
  type WrappedCanvas,
} from "mediabunny";

/**
 * Plays what the browser will not, by decoding it rather than repackaging it.
 *
 * Everything before this tried to hand the browser a file it would accept:
 * Matroska rewritten as fragmented MP4, fed through Media Source. That fails
 * for reasons that have nothing to do with whether the machine can decode the
 * video — a codec string whose prefix disagrees with the sample entry, a MIME
 * type Media Source declines, an initialization segment rejected without a
 * reason. Chromium decodes 4K HEVC quite happily; it just would not accept it
 * through that door.
 *
 * So this opens a different one. Frames are decoded with WebCodecs and drawn
 * to a canvas, audio is decoded to buffers and played through Web Audio, and
 * no container is ever written. There is no MIME type to get wrong.
 *
 * The cost is real and worth stating: no hardware-accelerated video element,
 * no AirPlay, no picture-in-picture, no background audio. It is the fallback,
 * not the default — anything the browser plays natively should still be given
 * to a <video> element instead.
 */

/** Registered once per page, and only when something actually needs it. */
let dolbyDecoder: Promise<void> | null = null;
function ensureDolbyDecoder() {
  dolbyDecoder ??= import("@mediabunny/ac3")
    .then(({ registerAc3Decoder }) => registerAc3Decoder())
    .catch(() => {
      // Dolby audio then reports itself undecodable, which is said plainly
      // rather than playing silence.
    });
  return dolbyDecoder;
}

export type PlayerState =
  | "loading"
  | "buffering"
  | "ready"
  | "ended"
  | "error";

export type PlayerStatus = { state: PlayerState; message: string };

export type MediabunnyPlayerOptions = {
  requestHeaders?: Record<string, string>;
  startPositionSeconds?: number;
  onTime?(currentTime: number, duration: number): void;
  onEnded?(): void;
};

/**
 * Folds any channel layout down to stereo without losing a channel.
 *
 * Web Audio will downmix on its own, but only correctly if the channels are in
 * the order it assumes — SMPTE's L R C LFE Ls Rs. Decoders do not agree on
 * that: AC-3's native order is L C R Ls Rs LFE, and handing one to the other
 * puts the centre channel where the right channel is expected. Since dialogue
 * lives almost entirely in the centre, getting that wrong is exactly the
 * failure where the music plays and nobody speaks.
 *
 * Rather than guess the order, every channel is mixed into both sides. A known
 * layout gets the ITU coefficients and proper stereo placement; an unknown one
 * still contributes to both, which may place a voice imprecisely but can never
 * silence it. Losing the dialogue is the one outcome worth ruling out
 * structurally rather than hoping for.
 */
function downmixToStereo(
  buffer: AudioBuffer,
  context: AudioContext,
): AudioBuffer {
  if (buffer.numberOfChannels <= 2) return buffer;

  const frames = buffer.length;
  const stereo = context.createBuffer(2, frames, buffer.sampleRate);
  const left = stereo.getChannelData(0);
  const right = stereo.getChannelData(1);

  // ITU-R BS.775: side channels at -3dB, centre split equally between both.
  const HALF_POWER = Math.SQRT1_2;
  // 5.1 as Web Audio reads it. Anything else falls through to the even mix
  // below, which is imprecise but complete.
  const smpte51 = buffer.numberOfChannels === 6;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    let toLeft = HALF_POWER;
    let toRight = HALF_POWER;
    if (smpte51) {
      // L, R, C, LFE, Ls, Rs
      if (channel === 0) (toLeft = 1), (toRight = 0);
      else if (channel === 1) (toLeft = 0), (toRight = 1);
      else if (channel === 2) (toLeft = HALF_POWER), (toRight = HALF_POWER);
      // The LFE carries no dialogue and muddies a stereo mix; the standard
      // downmix drops it.
      else if (channel === 3) continue;
      else if (channel === 4) (toLeft = HALF_POWER), (toRight = 0);
      else if (channel === 5) (toLeft = 0), (toRight = HALF_POWER);
    }
    for (let frame = 0; frame < frames; frame += 1) {
      left[frame] += source[frame] * toLeft;
      right[frame] += source[frame] * toRight;
    }
  }

  // Summing channels can exceed full scale, and clipping sounds far worse than
  // being a little quiet.
  let peak = 0;
  for (const channel of [left, right])
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.abs(channel[frame]);
      if (value > peak) peak = value;
    }
  if (peak > 1) {
    const scale = 1 / peak;
    for (const channel of [left, right])
      for (let frame = 0; frame < frames; frame += 1) channel[frame] *= scale;
  }
  return stereo;
}

export class MediabunnyPlayer {
  private input: Input | null = null;
  private videoTrack: InputVideoTrack | null = null;
  private audioTrack: InputAudioTrack | null = null;
  private videoSink: CanvasSink | null = null;
  private audioSink: AudioBufferSink | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;

  private stopped = false;
  private playing = false;
  private generation = 0;
  private queuedNodes = new Set<AudioBufferSourceNode>();
  private frameHandle: number | null = null;

  /** Where playback sits when paused, and the origin the audio clock counts from. */
  private pausedAt = 0;
  private contextStartTime = 0;
  private startedFrom = 0;
  private volume = 1;
  private muted = false;

  duration = 0;

  constructor(
    private url: string,
    private canvas: HTMLCanvasElement,
    private onStatus: (status: PlayerStatus) => void,
    private options: MediabunnyPlayerOptions = {},
  ) {}

  get currentTime() {
    if (!this.playing || !this.context) return this.pausedAt;
    return this.startedFrom + (this.context.currentTime - this.contextStartTime);
  }

  get paused() {
    return !this.playing;
  }

  async start() {
    this.report("loading", "Reading the stream…");
    // Before any track is asked whether it can be decoded, because the answer
    // for Dolby depends on this. No browser's own AudioDecoder handles AC-3 or
    // E-AC-3, and most of what needs this player at all carries one of them —
    // without this they would report themselves undecodable and play silent.
    // Loaded on demand: it is around a megabyte, and a file with ordinary
    // audio should never pay for it.
    await ensureDolbyDecoder();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(this.url, {
        requestInit: this.options.requestHeaders
          ? { headers: this.options.requestHeaders }
          : undefined,
      }),
    });
    this.input = input;

    const [video, audio] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);

    // Asked before anything is decoded, so an unplayable track is reported as
    // such rather than as a stall.
    const trouble: string[] = [];
    this.videoTrack =
      video && (await video.canDecode().catch(() => false)) ? video : null;
    if (video && !this.videoTrack) trouble.push("its video");
    this.audioTrack =
      audio && (await audio.canDecode().catch(() => false)) ? audio : null;
    if (audio && !this.audioTrack) trouble.push("its audio");

    if (!this.videoTrack && !this.audioTrack) {
      this.report(
        "error",
        trouble.length
          ? `This browser cannot decode ${trouble.join(" or ")}. Try an external player.`
          : "This file contains no video or audio track that could be read.",
      );
      return;
    }

    this.duration = await input.computeDuration().catch(() => 0);

    if (this.audioTrack) {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      // Matching the file's rate keeps low-rate audio from being resampled
      // into something that sounds wrong.
      this.context = new AudioContextClass({
        sampleRate: await this.audioTrack.getSampleRate(),
      });
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.applyVolume();
      this.audioSink = new AudioBufferSink(this.audioTrack);
    }

    if (this.videoTrack) {
      this.canvas.width = await this.videoTrack.getDisplayWidth();
      this.canvas.height = await this.videoTrack.getDisplayHeight();
      this.videoSink = new CanvasSink(this.videoTrack, {
        poolSize: 2,
        fit: "contain",
      });
    }

    if (trouble.length)
      this.report(
        "buffering",
        `Playing without ${trouble.join(" or ")}, which this browser cannot decode.`,
      );

    await this.seek(this.options.startPositionSeconds ?? 0);
  }

  /**
   * Starts playing.
   *
   * Must be reached from a real interaction the first time. Safari leaves a
   * new AudioContext suspended and only lets a gesture resume it, which is why
   * the example this grew out of is silent there while Chrome is fine.
   */
  async play() {
    if (this.stopped || this.playing) return;
    if (this.context?.state === "suspended") await this.context.resume();
    this.playing = true;
    this.startedFrom = this.pausedAt;
    this.contextStartTime = this.context?.currentTime ?? 0;
    this.run(++this.generation);
    this.report("ready", "");
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.currentTime;
    this.playing = false;
    this.generation += 1;
    this.silence();
  }

  async seek(seconds: number) {
    const target = Math.max(0, Math.min(seconds, this.duration || seconds));
    const wasPlaying = this.playing;
    this.playing = false;
    this.generation += 1;
    this.silence();
    this.pausedAt = target;
    // A still frame at the destination, so scrubbing shows where it landed
    // rather than freezing on where it left.
    if (this.videoSink) {
      const frame = await this.videoSink.getCanvas(target).catch(() => null);
      if (frame) this.draw(frame);
    }
    if (wasPlaying) await this.play();
    else this.options.onTime?.(this.currentTime, this.duration);
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    this.applyVolume();
  }

  setMuted(value: boolean) {
    this.muted = value;
    this.applyVolume();
  }

  stop() {
    this.stopped = true;
    this.playing = false;
    this.generation += 1;
    this.silence();
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    void this.context?.close().catch(() => undefined);
    try {
      this.input?.dispose();
    } catch {
      // Already gone, or never opened.
    }
  }

  private applyVolume() {
    if (this.gain)
      // Quadratic, because loudness is not linear in the slider's travel.
      this.gain.gain.value = this.muted ? 0 : this.volume ** 2;
  }

  private silence() {
    for (const node of this.queuedNodes) {
      try {
        node.stop();
      } catch {
        // Already finished; nothing to stop.
      }
    }
    this.queuedNodes.clear();
  }

  private draw(frame: WrappedCanvas) {
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(frame.canvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  private report(state: PlayerState, message: string) {
    if (!this.stopped) this.onStatus({ state, message });
  }

  /** Video and audio each run their own loop, both reading the same clock. */
  private run(generation: number) {
    void this.runVideo(generation);
    void this.runAudio(generation);
    const tick = () => {
      if (this.generation !== generation || this.stopped) return;
      this.options.onTime?.(this.currentTime, this.duration);
      if (this.duration && this.currentTime >= this.duration) {
        this.playing = false;
        this.silence();
        this.report("ended", "");
        this.options.onEnded?.();
        return;
      }
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  private async runVideo(generation: number) {
    if (!this.videoSink) return;
    const start = this.startedFrom;
    let pending: WrappedCanvas | null = null;
    for await (const frame of this.videoSink.canvases(start)) {
      if (this.generation !== generation || this.stopped) return;
      // Held until its moment, then drawn — the audio clock decides when, so
      // the two stay together rather than drifting apart.
      pending = frame;
      while (pending && pending.timestamp > this.currentTime) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (this.generation !== generation || this.stopped) return;
      }
      if (pending) this.draw(pending);
      pending = null;
    }
  }

  private async runAudio(generation: number) {
    if (!this.audioSink || !this.context || !this.gain) return;
    const context = this.context;
    for await (const { buffer, timestamp } of this.audioSink.buffers(
      this.startedFrom,
    )) {
      if (this.generation !== generation || this.stopped) return;
      const node = context.createBufferSource();
      node.buffer = downmixToStereo(buffer, context);
      node.connect(this.gain);

      let at = this.contextStartTime + timestamp - this.startedFrom;
      // Rounded to a sample boundary, or consecutive buffers land fractionally
      // apart and click.
      at = Math.round(context.sampleRate * at) / context.sampleRate;
      if (at >= context.currentTime) node.start(at);
      else node.start(context.currentTime, context.currentTime - at);

      this.queuedNodes.add(node);
      node.onended = () => this.queuedNodes.delete(node);

      // Stay a few seconds ahead and no further: decoding the whole file into
      // memory would be the same mistake the streaming remuxer made.
      while (
        timestamp - this.currentTime > 3 &&
        this.generation === generation &&
        !this.stopped
      )
        await new Promise((resolve) => setTimeout(resolve, 120));
      if (this.generation !== generation || this.stopped) return;
    }
  }
}
