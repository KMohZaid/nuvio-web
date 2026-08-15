import type Hls from "hls.js";
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
}: {
  stream: Stream;
  meta: Meta;
  video?: Video;
  onClose(): void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState("Preparing video…");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
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
      element.currentTime = clamp(
        element.currentTime + amount,
        0,
        Number.isFinite(element.duration)
          ? element.duration
          : element.currentTime + amount,
      );
      setCurrentTime(element.currentTime);
      showControls();
    },
    [showControls],
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
    const isHls = /\.m3u8(?:$|\?)/i.test(url);
    const fail = () => {
      setWaiting(false);
      setStatus("");
      setError(
        "The browser could not play this video or audio format. Try the external player option.",
      );
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
      setSelectedAudio(
        choices.find((choice) => list[choice.id].enabled)?.id ?? 0,
      );
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
      setWaiting(true);
      setStatus("Buffering…");
    };
    const onCanPlay = () => {
      setWaiting(false);
      setStatus("");
    };
    const onTime = () => setCurrentTime(element.currentTime || 0);
    const onDuration = () => {
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      syncNativeAudio();
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
    return () => {
      disposed = true;
      window.clearTimeout(hideTimer.current);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("durationchange", onDuration);
      element.removeEventListener("loadedmetadata", onDuration);
      element.removeEventListener("volumechange", onVolume);
      element.removeEventListener("error", fail);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
    // Volume is initialized once per source; UI changes update the element directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, showControls]);

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

  return (
    <div
      ref={playerRef}
      className={`player-view ${controlsVisible || error ? "controls-visible" : "controls-hidden"}`}
      onPointerMove={showControls}
      onPointerDown={showControls}
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay
        preload="auto"
        poster={video?.thumbnail || meta.background}
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
          </small>
          <strong>{video?.title || meta.name}</strong>
        </div>
      </div>
      {!error && (
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
      {status && !error && <div className="player-status">{status}</div>}
      <div className="player-controls">
        <div className="player-timeline">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (videoRef.current) videoRef.current.currentTime = next;
              setCurrentTime(next);
            }}
            style={
              {
                "--played": `${duration ? (currentTime / duration) * 100 : 0}%`,
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
