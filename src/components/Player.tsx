import type Hls from "hls.js";
import { copyStreamUrl } from "../lib/externalPlayer";
import {
  assessPlayback,
  audioIsSilent,
  shouldUseRemuxFallback,
} from "../lib/playback";
import { StableRemuxStreamer } from "../lib/stableRemuxStreamer";
import {
  browserColor,
  type WebPlayerSettings,
} from "../lib/webSettings";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FastForward,
  LoaderCircle,
  Maximize,
  Music2,
  Pause,
  Play,
  Rewind,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Meta, Stream, Video } from "../types";

type AudioChoice = { id: number; label: string };
type NativeAudioTrackList = {
  length: number;
  [index: number]: { enabled: boolean; label?: string; language?: string };
};
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);
function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(value / 60) % 60;
  const hours = Math.floor(value / 3600);
  return hours
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function Player({
  stream,
  meta,
  video,
  onClose,
  onProgress,
  settings,
  startPositionMs = 0,
}: {
  stream: Stream;
  meta: Meta;
  video?: Video;
  onClose(): void;
  /** Where to resume from. 0 starts at the beginning. */
  startPositionMs?: number;
  /** Reports a resume point. Fired periodically, on pause, and on exit. */
  onProgress(positionMs: number, durationMs: number, ended: boolean): void;
  settings: WebPlayerSettings;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [remuxActive, setRemuxActive] = useState(false);
  const [warning, setWarning] = useState("");
  useEffect(() => {
    if (!warning) return;
    const timer = window.setTimeout(() => setWarning(""), 6000);
    return () => window.clearTimeout(timer);
  }, [warning]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Kept in a ref so the reporting effect can run once for the whole session
  // rather than resubscribing on every timeupdate.
  const reportRef = useRef(onProgress);
  reportRef.current = onProgress;
  const [volume, setVolume] = useState(() =>
    Number(localStorage.getItem("nuvio-web-volume") ?? 1),
  );
  const [muted, setMuted] = useState(
    () => localStorage.getItem("nuvio-web-muted") === "true",
  );
  const [controlsVisible, setControlsVisible] = useState(true);
  const [audioOpen, setAudioOpen] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioChoice[]>([]);
  const [selectedAudio, setSelectedAudio] = useState(-1);
  const url = stream.url;
  const externalUrl = stream.externalUrl || url;
  const sourceText = `${stream.name} ${stream.title} ${stream.description} ${stream.behaviorHints?.filename ?? ""}`;
  const riskyAudio = useMemo(
    () => /truehd|dts(?:-hd)?|e-?ac-?3|dd\+|atmos|\.mkv\b/i.test(sourceText),
    [sourceText],
  );
  const videoFit =
    settings.resizeMode === "Stretch"
      ? "fill"
      : settings.resizeMode === "Fit"
        ? "contain"
        : "cover";
  const cueCss = useMemo(() => {
    const color = browserColor(settings.subtitleTextColor, "#fff");
    const background = browserColor(
      settings.subtitleBackgroundColor,
      "transparent",
    );
    const outline = browserColor(settings.subtitleOutlineColor, "#000");
    const width = clamp(settings.subtitleOutlineWidth, 0, 10);
    const shadow = settings.subtitleOutlineEnabled
      ? `${width}px 0 ${outline}, -${width}px 0 ${outline}, 0 ${width}px ${outline}, 0 -${width}px ${outline}`
      : "none";
    return `.player-view video::cue { color:${color}; background:${background}; font-size:${clamp(settings.subtitleFontSizeSp, 6, 40)}px; font-weight:${settings.subtitleBold ? 700 : 400}; text-shadow:${shadow}; }`;
  }, [settings]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    if (videoRef.current && !videoRef.current.paused)
      hideTimer.current = window.setTimeout(() => {
        setAudioOpen(false);
        setControlsVisible(false);
      }, 3000);
  }, []);
  const togglePlayback = useCallback(async () => {
    const element = videoRef.current;
    if (!element) return;
    showControls();
    if (element.paused) {
      try {
        await element.play();
        setError("");
      } catch {
        setStatus("Playback needs another tap or this codec is not supported.");
      }
    } else element.pause();
  }, [showControls]);
  const seekBy = useCallback(
    (amount: number) => {
      const element = videoRef.current;
      if (!element) return;
      let minimum = 0;
      let maximum = Number.isFinite(element.duration)
        ? element.duration
        : element.currentTime + Math.max(amount, 0);
      if (remuxActive && element.buffered.length) {
        for (let index = 0; index < element.buffered.length; index += 1) {
          if (
            element.currentTime >= element.buffered.start(index) - 0.5 &&
            element.currentTime <= element.buffered.end(index) + 0.5
          ) {
            minimum = element.buffered.start(index);
            maximum = Math.max(minimum, element.buffered.end(index) - 0.05);
            break;
          }
        }
      }
      element.currentTime = clamp(
        element.currentTime + amount,
        minimum,
        maximum,
      );
      setCurrentTime(element.currentTime);
      showControls();
    },
    [showControls, remuxActive],
  );
  const toggleFullscreen = useCallback(async () => {
    const container = playerRef.current;
    const element = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!container || !element) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (container.requestFullscreen) await container.requestFullscreen();
    else element.webkitEnterFullscreen?.();
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !url) {
      setWaiting(false);
      setError("This source does not provide a direct browser video URL.");
      return;
    }
    let disposed = false;
    let remuxer: StableRemuxStreamer | null = null;
    let audioWatch: number | undefined;
    let preferredAudioApplied = false;
    let preferredSubtitleApplied = false;
    const isHls = /\.m3u8(?:$|\?)/i.test(url);
    const fail = () => {
      // The remuxer listens to the media element itself and can report the
      // rejected codec/segment. Do not replace that with the generic error.
      if (remuxer) return;
      setWaiting(false);
      setStatus("");
      setError(
        "The browser could not play this video or audio format. Try the external player option.",
      );
    };
    const normalizeLanguage = (value?: string) =>
      (value || "").trim().toLowerCase().split(/[-_]/)[0];
    const languageTargets = (
      primary: string,
      secondary: string,
      includeOriginal: boolean,
    ) => {
      const device = navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
      const requested: string[] =
        primary === "device"
          ? [...device]
          : primary === "original" && includeOriginal
            ? [meta.language || "", ...device]
            : [primary];
      if (secondary) requested.push(secondary);
      return requested.map(normalizeLanguage).filter(Boolean);
    };
    const preferredTrack = (
      tracks: Array<{ language?: string; label?: string }>,
      targets: string[],
    ) => {
      for (const target of targets) {
        const exact = tracks.findIndex(
          (track) => normalizeLanguage(track.language) === target,
        );
        if (exact >= 0) return exact;
        const labelled = tracks.findIndex((track) =>
          (track.label || "").toLowerCase().includes(target),
        );
        if (labelled >= 0) return labelled;
      }
      return -1;
    };
    const syncNativeAudio = () => {
      const list = (
        element as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }
      ).audioTracks;
      if (!list?.length) return;
      const choices = Array.from({ length: list.length }, (_, index) => ({
        id: index,
        label:
          list[index].label || list[index].language || `Audio ${index + 1}`,
      }));
      setAudioTracks(choices);
      if (!preferredAudioApplied) {
        const preferred = preferredTrack(
          Array.from({ length: list.length }, (_, index) => list[index]),
          languageTargets(
            settings.preferredAudioLanguage,
            settings.secondaryPreferredAudioLanguage,
            true,
          ),
        );
        if (preferred >= 0) {
          for (let index = 0; index < list.length; index += 1)
            list[index].enabled = index === preferred;
        }
        preferredAudioApplied = true;
      }
      setSelectedAudio(
        choices.find((choice) => list[choice.id].enabled)?.id ?? 0,
      );
    };
    const syncNativeSubtitles = () => {
      const list = element.textTracks;
      if (!list.length || preferredSubtitleApplied) return;
      preferredSubtitleApplied = true;
      const preferred = settings.preferredSubtitleLanguage;
      const targets =
        preferred === "none"
          ? []
          : languageTargets(
              preferred,
              settings.secondaryPreferredSubtitleLanguage,
              false,
            );
      const selected = preferredTrack(
        Array.from({ length: list.length }, (_, index) => list[index]),
        targets,
      );
      for (let index = 0; index < list.length; index += 1)
        list[index].mode = index === selected ? "showing" : "disabled";
    };
    const applyCueOffset = () => {
      const offset = clamp(settings.subtitleBottomOffset, 0, 100);
      const height = element.clientHeight || 1;
      const line = 100 - (offset / height) * 100;
      for (let trackIndex = 0; trackIndex < element.textTracks.length; trackIndex += 1) {
        const cues = element.textTracks[trackIndex].cues;
        if (!cues) continue;
        for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
          const cue = cues[cueIndex] as TextTrackCue & {
            line?: number | "auto";
            snapToLines?: boolean;
          };
          if (typeof cue.line !== "undefined") {
            cue.snapToLines = false;
            cue.line = line;
          }
        }
      }
    };
    element.volume = clamp(Number.isFinite(volume) ? volume : 1, 0, 1);
    element.muted = muted;
    element.playsInline = true;
    const onPlaying = () => {
      setPlaying(true);
      setWaiting(false);
      setStatus("");
      showControls();
    };
    const onPause = () => {
      setPlaying(false);
      setControlsVisible(true);
      window.clearTimeout(hideTimer.current);
    };
    const onWaiting = () => {
      // No status text: the centre spinner already says this, and showing
      // both read as two separate loading indicators stacked on each other.
      setWaiting(true);
    };
    const onCanPlay = () => {
      setWaiting(false);
      setStatus("");
    };
    // Seek once, on the first metadata event: setting currentTime before the
    // duration is known is silently ignored, and re-seeking on every event
    // would fight the user.
    let resumed = startPositionMs <= 0;
    const onResume = () => {
      // The sequential remux prototype does not have cue-based seeking yet.
      // Jumping to an unbuffered resume point makes it download from byte zero
      // until it reaches that point and looks like a permanent stall.
      if (remuxer || resumed || !Number.isFinite(element.duration)) return;
      resumed = true;
      const target = startPositionMs / 1000;
      // Never seek past the end; a stale row from a different cut of the same
      // episode would otherwise drop playback at the credits.
      if (target < element.duration - 5) element.currentTime = target;
    };
    element.addEventListener("loadedmetadata", onResume);
    element.addEventListener("canplay", onResume);
    const onTime = () => setCurrentTime(element.currentTime || 0);
    const onDuration = () => {
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      syncNativeAudio();
      syncNativeSubtitles();
      applyCueOffset();
    };
    const onVolume = () => {
      setVolume(element.volume);
      setMuted(element.muted);
    };
    element.addEventListener("playing", onPlaying);
    element.addEventListener("pause", onPause);
    element.addEventListener("waiting", onWaiting);
    element.addEventListener("canplay", onCanPlay);
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("durationchange", onDuration);
    element.addEventListener("loadedmetadata", onDuration);
    element.addEventListener("volumechange", onVolume);
    element.addEventListener("error", fail);

    const cleanup = () => {
      disposed = true;
      remuxer?.stop();
      setRemuxActive(false);
      window.clearTimeout(hideTimer.current);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("loadedmetadata", onResume);
      element.removeEventListener("canplay", onResume);
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("durationchange", onDuration);
      element.removeEventListener("loadedmetadata", onDuration);
      element.removeEventListener("volumechange", onVolume);
      element.removeEventListener("error", fail);
      if (audioWatch !== undefined) window.clearInterval(audioWatch);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };

    // Re-box Matroska into fMP4 before native playback on every MSE-capable
    // browser. Chromium otherwise accepts the video and silently drops common
    // Dolby audio, so waiting for `playable === false` is too late.
    const verdict = assessPlayback(url, sourceText);
    if (shouldUseRemuxFallback(url, sourceText)) {
        setRemuxActive(true);
        remuxer = new StableRemuxStreamer(
          url,
          element,
          (next) => {
            if (disposed) return;
            if (next.state === "error") {
              setWaiting(false);
              setStatus("");
              setError(next.message);
            } else if (next.state === "ready" || next.state === "ended") {
              setWaiting(false);
              setStatus("");
            } else {
              setWaiting(true);
              setStatus("");
            }
          },
          {
            requestHeaders: stream.behaviorHints?.proxyHeaders?.request,
            preferredAudioLanguage: settings.preferredAudioLanguage,
          },
        );
        void remuxer.start().catch((reason: unknown) => {
          if (disposed) return;
          setWaiting(false);
          setError(
            reason instanceof Error
              ? reason.message
              : "The local remux pipeline failed.",
          );
        });
      return cleanup;
    }
    if (!verdict.playable) {
      setError(verdict.reason);
      setWaiting(false);
      return cleanup;
    }

    // Chromium reports no error for an audio codec it cannot decode; it just
    // plays silence. Sample the decoded-byte counters once playback is under
    // way and say so plainly.
    audioWatch = window.setInterval(() => {
      if (element.paused || element.currentTime < 1.5) return;
      if (audioIsSilent(element)) {
        setWarning(
          verdict.reason ||
            "No audio track could be decoded by this browser. Try an external player.",
        );
        window.clearInterval(audioWatch);
      }
    }, 1200);
    if (isHls && element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = url;
      element.load();
      element.play().catch(() => setStatus("Tap play to start"));
    } else if (isHls) {
      import("hls.js")
        .then(({ default: HlsClass }) => {
          if (disposed) return;
          if (!HlsClass.isSupported()) {
            fail();
            return;
          }
          const hls = new HlsClass({
            enableWorker: true,
            lowLatencyMode: false,
          });
          hlsRef.current = hls;
          hls.loadSource(url);
          hls.attachMedia(element);
          const syncTracks = () => {
            const tracks = hls.audioTracks.map((track, index) => ({
              id: index,
              label: track.name || track.lang || `Audio ${index + 1}`,
            }));
            setAudioTracks(tracks);
            if (!preferredAudioApplied) {
              const preferred = preferredTrack(
                hls.audioTracks.map((track) => ({
                  language: track.lang,
                  label: track.name,
                })),
                languageTargets(
                  settings.preferredAudioLanguage,
                  settings.secondaryPreferredAudioLanguage,
                  true,
                ),
              );
              if (preferred >= 0) hls.audioTrack = preferred;
              preferredAudioApplied = true;
            }
            setSelectedAudio(hls.audioTrack);
          };
          hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
            syncTracks();
            element.play().catch(() => setStatus("Tap play to start"));
          });
          hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, syncTracks);
          hls.on(HlsClass.Events.AUDIO_TRACK_SWITCHED, (_, data) =>
            setSelectedAudio(data.id),
          );
          hls.on(HlsClass.Events.ERROR, (_, data) => {
            if (data.fatal) fail();
          });
        })
        .catch(fail);
    } else {
      element.src = url;
      element.load();
      element.play().catch(() => setStatus("Tap play to start"));
    }
    return cleanup;
    // Volume is initialized once per source; UI changes update the element directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, showControls, settings, meta.language]);

  useEffect(() => {
    localStorage.setItem("nuvio-web-volume", String(volume));
    localStorage.setItem("nuvio-web-muted", String(muted));
  }, [volume, muted]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        ["INPUT", "SELECT", "TEXTAREA"].includes(
          (event.target as HTMLElement)?.tagName,
        )
      )
        return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") seekBy(-10);
      else if (event.key === "ArrowRight") seekBy(10);
      else if (event.key.toLowerCase() === "m" && videoRef.current)
        videoRef.current.muted = !videoRef.current.muted;
      else if (event.key.toLowerCase() === "f") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekBy, toggleFullscreen, togglePlayback]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const report = (ended: boolean) => {
      const position = element.currentTime * 1000;
      const total = Number.isFinite(element.duration)
        ? element.duration * 1000
        : 0;
      if (position > 0 || ended) reportRef.current(position, total, ended);
    };
    // Every 15s while playing, plus the moments a position actually matters.
    const timer = window.setInterval(() => {
      if (!element.paused) report(false);
    }, 15_000);
    const onPause = () => report(false);
    const onEnded = () => report(true);
    // `pagehide` rather than `unload`: iOS never fires unload for a PWA being
    // backgrounded, so the last position would be lost every time.
    const onHide = () => report(element.ended);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onEnded);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(timer);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("ended", onEnded);
      window.removeEventListener("pagehide", onHide);
      // Closing the player is the most important report of all.
      report(element.ended);
    };
  }, []);

  const selectAudio = (id: number) => {
    if (hlsRef.current) hlsRef.current.audioTrack = id;
    else {
      const list = (
        videoRef.current as
          (HTMLVideoElement & { audioTracks?: NativeAudioTrackList }) | null
      )?.audioTracks;
      if (list)
        for (let index = 0; index < list.length; index += 1)
          list[index].enabled = index === id;
    }
    setSelectedAudio(id);
    setAudioOpen(false);
  };
  const setPlayerVolume = (next: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.volume = next;
    element.muted = next === 0;
  };
  const seekLimit = (() => {
    const element = videoRef.current;
    if (!remuxActive || !element?.buffered.length) return duration || 0;
    for (let index = 0; index < element.buffered.length; index += 1)
      if (
        currentTime >= element.buffered.start(index) - 0.5 &&
        currentTime <= element.buffered.end(index) + 0.5
      )
        return element.buffered.end(index);
    return Math.max(currentTime, 0);
  })();

  return (
    <div
      ref={playerRef}
      className={`player-view ${controlsVisible || error ? "controls-visible" : "controls-hidden"}`}
      onPointerMove={showControls}
      onPointerDown={showControls}
    >
      <style>{cueCss}</style>
      <video
        ref={videoRef}
        playsInline
        autoPlay
        preload="auto"
        poster={video?.thumbnail || meta.background}
        style={{ objectFit: videoFit }}
        onDoubleClick={toggleFullscreen}
      />
      <div className="player-shade player-shade-top" />
      <div className="player-shade player-shade-bottom" />
      <div className="player-top">
        <button className="circle-button" aria-label="Back" onClick={onClose}>
          <ArrowLeft />
        </button>
        <div>
          <small>
            {video?.season
              ? `Season ${video.season} · Episode ${video.episode}`
              : meta.type}
            {settings.showParentalGuide && meta.ageRating
              ? ` · ${meta.ageRating}`
              : ""}
          </small>
          <strong>{video?.title || meta.name}</strong>
        </div>
      </div>
      {!error && (!waiting || settings.showLoadingOverlay) && (
        <button
          className="player-center"
          aria-label={playing ? "Pause" : "Play"}
          onClick={togglePlayback}
        >
          {waiting ? (
            <LoaderCircle className="spin" />
          ) : playing ? (
            <Pause />
          ) : (
            <Play />
          )}
        </button>
      )}
      {status && !waiting && !error && (
        <div className="player-status">{status}</div>
      )}
      {warning && !error && (
        <div className="player-warning" role="status">
          <span>{warning}</span>
          {externalUrl && (
            <button
              className="warning-action"
              onClick={() => copyStreamUrl(externalUrl)}
            >
              <Copy size={15} /> Copy stream URL
            </button>
          )}
          <button
            className="notice-dismiss"
            aria-label="Dismiss"
            onClick={() => setWarning("")}
          >
            <X size={18} />
          </button>
        </div>
      )}
      <div className="player-controls">
        <div className="player-timeline">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={seekLimit}
            step="0.1"
            value={Math.min(currentTime, seekLimit)}
            onChange={(event) => {
              const next = Number(event.target.value);
              const element = videoRef.current;
              if (!element) return;
              let target = next;
              if (remuxActive && element.buffered.length) {
                let allowed = false;
                for (let index = 0; index < element.buffered.length; index += 1) {
                  if (
                    target >= element.buffered.start(index) &&
                    target <= element.buffered.end(index)
                  ) {
                    allowed = true;
                    break;
                  }
                }
                if (!allowed) target = element.currentTime;
              }
              element.currentTime = target;
              setCurrentTime(target);
            }}
            style={
              {
                "--played": `${seekLimit ? (currentTime / seekLimit) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <span>{formatTime(duration)}</span>
        </div>
        <div className="player-control-row">
          <div className="player-control-group">
            <button aria-label="Rewind 10 seconds" onClick={() => seekBy(-10)}>
              <Rewind />
              <small>10</small>
            </button>
            <button
              className="player-play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={togglePlayback}
            >
              {playing ? <Pause /> : <Play />}
            </button>
            <button aria-label="Forward 10 seconds" onClick={() => seekBy(10)}>
              <FastForward />
              <small>10</small>
            </button>
          </div>
          <div className="player-control-group player-control-right">
            <button
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => {
                if (videoRef.current)
                  videoRef.current.muted = !videoRef.current.muted;
              }}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              className="volume-slider"
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.02"
              value={muted ? 0 : volume}
              onChange={(event) => setPlayerVolume(Number(event.target.value))}
              style={
                {
                  "--played": `${muted ? 0 : volume * 100}%`,
                } as CSSProperties
              }
            />
            <div className="audio-picker">
              <button
                className={audioOpen ? "active" : ""}
                aria-expanded={audioOpen}
                onClick={() => setAudioOpen((value) => !value)}
              >
                <Music2 />
                <span>Audio</span>
              </button>
              {audioOpen && (
                <div className="audio-menu">
                  <strong>Audio track</strong>
                  {audioTracks.length ? (
                    audioTracks.map((track) => (
                      <button
                        key={track.id}
                        className={selectedAudio === track.id ? "selected" : ""}
                        onClick={() => selectAudio(track.id)}
                      >
                        {track.label}
                      </button>
                    ))
                  ) : (
                    <p>The browser reports only the default track.</p>
                  )}
                  {riskyAudio && (
                    <small>
                      This source advertises an audio/container format that
                      browsers may not decode. Use an external player if it
                      stays silent.
                    </small>
                  )}
                  {externalUrl && (
                    <a href={externalUrl} target="_blank" rel="noreferrer">
                      <ExternalLink /> Open externally
                    </a>
                  )}
                </div>
              )}
            </div>
            <button aria-label="Fullscreen" onClick={toggleFullscreen}>
              <Maximize />
            </button>
          </div>
        </div>
      </div>
      {error && (
        <div className="player-error">
          <strong>Browser playback unavailable</strong>
          <p>{error}</p>
          <div>
            {externalUrl && (
              <>
                <a href={externalUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open stream
                </a>
                <button
                  onClick={() => navigator.clipboard.writeText(externalUrl)}
                >
                  <Copy /> Copy URL
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
