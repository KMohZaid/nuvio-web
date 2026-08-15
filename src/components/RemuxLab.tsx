import { useRef, useState } from "react";
import {
  mediaSourceSupport,
  planRemux,
  probeMatroska,
  verdictFor,
  type ProbeResult,
} from "../lib/matroska";
import { scanBlocks, type BlockScan } from "../lib/matroskaBlocks";
import { describeTrack, samplesFor } from "../lib/remux";
import { RemuxStreamer, type StreamerStatus } from "../lib/remuxStreamer";
import { buildInitSegment, buildMediaSegment } from "../lib/fmp4";

/**
 * Step one of the remux spike: can this device read a real debrid file and
 * make sense of it?
 *
 * Three things have to hold before any of the rest is worth writing — the host
 * must honour byte ranges, the Matroska header must be parseable from the
 * front of the file, and MSE must exist. If any fails, that is the answer and
 * no demuxer needs building.
 */
export function RemuxLab({ onBack }: { onBack(): void }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    setScan(null);
    const started = performance.now();
    try {
      const probe = await probeMatroska(url.trim());
      setResult(probe);
      // Same bytes, no second request: proves frames can be located, not just
      // that the header parses.
      setScan(scanBlocks(probe.buffer));
      if (probe.tracks.length === 0)
        setError(
          "No tracks found in the first 2 MB. The file may put Tracks behind a SeekHead, which needs a second range request to resolve.",
        );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `${reason.message} This is usually CORS: the host has to allow the Range header and expose Content-Range.`
          : "Probe failed",
      );
    } finally {
      setBusy(false);
      setElapsed(Math.round(performance.now() - started));
    }
  };
  const [elapsed, setElapsed] = useState(0);
  const [scan, setScan] = useState<BlockScan | null>(null);
  const [copied, setCopied] = useState(false);
  const [playState, setPlayState] = useState("");
  const [stream, setStream] = useState<StreamerStatus | null>(null);
  const streamerRef = useRef<RemuxStreamer | null>(null);

  /**
   * Drops the cached build outright.
   *
   * The update toast is the polite path, but it is easy to miss and a stale
   * worker makes every later measurement a lie. Unregistering and clearing the
   * caches guarantees the next load is the build that was just deployed.
   */
  const forceUpdate = async () => {
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((registrations ?? []).map((one) => one.unregister()));
      const names = await caches?.keys?.();
      await Promise.all((names ?? []).map((name) => caches.delete(name)));
    } catch {
      // Best effort: a reload without the cache cleared is still worth doing.
    }
    window.location.reload();
  };

  const startStream = () => {
    const element = videoRef.current;
    if (!element || !url.trim()) return;
    streamerRef.current?.stop();
    setPlayState("");
    const streamer = new RemuxStreamer(url.trim(), element, setStream);
    streamerRef.current = streamer;
    void streamer.start();
  };
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Feeds one remuxed fragment to the video element.
   *
   * MSE reports configuration problems by rejecting the append rather than by
   * playing badly, so a failure here is specific and worth surfacing verbatim.
   */
  const buildReport = (probe: ProbeResult, blocks: BlockScan | null) => {
    const plan = planRemux(probe.tracks);
    const host = (() => {
      try {
        return new URL(probe.finalUrl || url).host;
      } catch {
        return "unknown host";
      }
    })();
    const lines = [
      "Nuvio remux probe",
      `host: ${host} (url withheld — carries an account token)`,
      `media source: ${mediaSourceSupport()}`,
      `http ${probe.status}${probe.redirected ? " (redirected)" : ""} · accept-ranges: ${probe.acceptRangesHeader ?? "absent"} · ranges ${probe.acceptsRanges ? "honoured" : "IGNORED"}`,
      `read ${(probe.bytesRead / 1024).toFixed(0)} KB${probe.totalBytes ? ` of ${(probe.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : ""} in ${elapsed} ms`,
      "",
      `plan: ${plan.needsAudioTranscode ? "needs an audio transcode" : "remuxable as-is"} — ${plan.summary}`,
      "",
      "tracks:",
      ...probe.tracks.map((track) => {
        const verdict = verdictFor(track);
        const shape = [
          track.width ? `${track.width}x${track.height}` : null,
          track.channels ? `${track.channels}ch` : null,
          track.language && track.language !== "und" ? track.language : null,
        ]
          .filter(Boolean)
          .join(" ");
        const status =
          track.kind === "subtitle"
            ? track.codecId.toUpperCase().startsWith("S_TEXT")
              ? "webvtt"
              : "dropped"
            : verdict.status;
        return `  ${track.kind.padEnd(8)} ${verdict.label.padEnd(11)} ${shape.padEnd(16)} ${status.padEnd(9)} ${track.codecId}`;
      }),
    ];
    if (blocks) {
      const keys = blocks.frames.filter((frame) => frame.keyframe).length;
      const times = blocks.frames.map((frame) => frame.timeMs);
      const span = times.length ? Math.max(...times) - Math.min(...times) : 0;
      const config = blocks.tracks.filter(
        (track) => track.codecPrivate?.length,
      ).length;
      lines.push(
        "",
        `frames: ${blocks.frames.length} across ${blocks.clusters} cluster(s) · ${keys} keyframes · ${(span / 1000).toFixed(2)}s spanned`,
        `timestamp scale ${blocks.timestampScaleNs / 1000}µs · ${config}/${blocks.tracks.length} tracks carry decoder config`,
        "",
        "per track:",
        ...blocks.tracks.map((track) => {
          const own = blocks.frames.filter(
            (frame) => frame.track === track.number,
          );
          const ownKeys = own.filter((frame) => frame.keyframe).length;
          const ownTimes = own.map((frame) => frame.timeMs);
          const ownSpan = ownTimes.length
            ? Math.max(...ownTimes) - Math.min(...ownTimes)
            : 0;
          return `  #${track.number} ${track.kind.padEnd(8)} ${track.codecId.padEnd(16)} ${String(own.length).padStart(5)} frames  ${String(ownKeys).padStart(4)} key  ${(ownSpan / 1000).toFixed(2).padStart(7)}s  ${track.codecPrivate?.length ? `${track.codecPrivate.length}B config` : "no config"}`;
        }),
        blocks.truncated ? "" : "",
        blocks.truncated ? "note: buffer ended mid-element (expected)" : "",
      );
    }
    return lines.filter((line) => line !== undefined).join("\n").trim();
  };

  const copyReport = async () => {
    if (!result) return;
    const text = buildReport(result, scan);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused even on HTTPS; a prompt is still
      // selectable, which beats screenshotting it.
      window.prompt("Copy the probe report", text);
    }
  };

  const attempt = async () => {
    if (!result || !scan) return;
    setPlayState("Preparing…");

    const codecStringFor = (entry: string) =>
      entry === "av01"
        ? "av01.0.08M.10"
        : entry === "hvc1"
          ? "hvc1.1.6.L93.B0"
          : entry === "avc1"
            ? "avc1.640028"
            : entry === "ec-3"
              ? "ec-3"
              : entry === "ac-3"
                ? "ac-3"
                : "mp4a.40.2";

    // Video first, then the best audio the plan chose — the same selection the
    // source list uses, so a TrueHD default does not get picked here either.
    const plan = planRemux(result.tracks);
    const pick = (kind: "video" | "audio", codecId?: string) =>
      scan.tracks.find(
        (track) =>
          track.kind === kind &&
          (!codecId || track.codecId === codecId) &&
          scan.frames.some((frame) => frame.track === track.number),
      );

    const videoTrack = pick("video", plan.video?.codecId);
    const audioTrack = pick("audio", plan.audio?.codecId);
    if (!videoTrack) {
      setPlayState("No video frames in this range.");
      return;
    }

    const firstFrameOf = (trackNumber: number) => {
      const frame = scan.frames.find((item) => item.track === trackNumber);
      return frame
        ? result.buffer.subarray(frame.offset, frame.offset + frame.size)
        : undefined;
    };

    const meta = result.tracks.find((track) => track.kind === "video");
    const video = describeTrack(videoTrack, meta?.width, meta?.height);
    if ("reason" in video) {
      setPlayState(video.reason);
      return;
    }
    const audio = audioTrack
      ? describeTrack(
          audioTrack,
          undefined,
          undefined,
          undefined,
          firstFrameOf(audioTrack.number),
        )
      : null;
    const audioReason = audio && "reason" in audio ? audio.reason : null;
    const audioTrackReady = audio && !("reason" in audio) ? audio : null;

    const mime = `video/mp4; codecs="${codecStringFor(video.sampleEntry)}${
      audioTrackReady ? `,${codecStringFor(audioTrackReady.sampleEntry)}` : ""
    }"`;
    const Source =
      (window as unknown as { ManagedMediaSource?: typeof MediaSource })
        .ManagedMediaSource ?? window.MediaSource;
    if (!Source?.isTypeSupported(mime)) {
      setPlayState(`This browser rejects ${mime}.`);
      return;
    }

    const element = videoRef.current;
    if (!element) return;
    const source = new Source();
    element.disableRemotePlayback = true;
    element.src = URL.createObjectURL(source as unknown as MediaSource);

    source.addEventListener("sourceopen", () => {
      try {
        // Both tracks share one buffer, which keeps their timelines aligned
        // without having to coordinate two independent append queues.
        const buffer = (source as MediaSource).addSourceBuffer(mime);
        const tracks = audioTrackReady ? [video, audioTrackReady] : [video];
        const init = buildInitSegment(tracks);
        const media = tracks.map((track) => {
          const samples = samplesFor(scan, result.buffer, track.id);
          const first = scan.frames
            .filter((frame) => frame.track === track.id)
            .reduce((lowest, frame) => Math.min(lowest, frame.timeMs), Infinity);
          return buildMediaSegment(
            1,
            track.id,
            Number.isFinite(first) ? Math.round(first) : 0,
            samples,
          );
        });

        const queue = [init, ...media];
        const pump = () => {
          const next = queue.shift();
          if (!next) {
            const end = buffer.buffered.length ? buffer.buffered.end(0) : 0;
            setPlayState(
              `Buffered ${end.toFixed(2)}s · ${tracks.length === 2 ? "video + audio" : "video only"}${
                audioReason ? ` · audio skipped: ${audioReason}` : ""
              } — press play.`,
            );
            return;
          }
          buffer.appendBuffer(next as unknown as BufferSource);
        };
        buffer.addEventListener("updateend", pump);
        buffer.addEventListener("error", () =>
          setPlayState("SourceBuffer rejected a segment."),
        );
        pump();
      } catch (error) {
        setPlayState(
          error instanceof Error ? error.message : "Could not open a buffer.",
        );
      }
    });
    setPlayState(`Appending as ${mime}…`);
  };

  return (
    <section className="settings-page">
      <div className="page-head">
        <button className="circle-button" aria-label="Back" onClick={onBack}>
          ←
        </button>
        <div>
          <span className="eyebrow">EXPERIMENT</span>
          <h1>Remux probe</h1>
          <p>
            Reads the front of an MKV and reports whether its streams could
            play here after being re-boxed into fMP4.
          </p>
        </div>
      </div>

      <div className="setting-card">
        <header>
          <h2>This device</h2>
        </header>
        <div className="info-row">
          <span>
            <strong>Media Source</strong>
            <small>{mediaSourceSupport()}</small>
          </span>
        </div>
        {/*
          The service worker registers as "prompt", so a phone keeps serving
          the build it already has until the update is accepted. Three rounds
          of debugging once produced byte-identical results because of it, so
          the running build is stated here and can be replaced on the spot.
        */}
        <div className="info-row">
          <span>
            <strong>Running build</strong>
            <small>{__APP_BUILD__}</small>
          </span>
          <button className="secondary" onClick={() => void forceUpdate()}>
            Force update
          </button>
        </div>
      </div>

      <form
        className="addon-install"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          type="url"
          value={url}
          placeholder="Paste a direct .mkv URL"
          onChange={(event) => setUrl(event.target.value)}
        />
        <button className="primary" disabled={busy || !url.trim()}>
          {busy ? "Probing…" : "Probe"}
        </button>
      </form>

      {error && <div className="notice error">{error}</div>}

      {scan && (
        <div className="setting-card">
          <header>
            <h2>Playback attempt</h2>
            <div className="source-sheet-tools">
              <button className="secondary" onClick={() => void attempt()}>
                One fragment
              </button>
              <button className="primary" onClick={startStream}>
                Stream
              </button>
            </div>
          </header>
          {playState && (
            <div className="info-row">
              <span>
                <small>{playState}</small>
              </span>
            </div>
          )}
          {stream && (
            <div className="info-row">
              <span>
                <strong>{stream.state}</strong>
                <small
                  className={
                    stream.state === "error" ? "probe-blocked" : "probe-ok"
                  }
                >
                  {stream.message}
                  {stream.bufferedSeconds != null
                    ? ` · ${stream.bufferedSeconds.toFixed(1)}s ahead`
                    : ""}
                  {stream.ranges ? ` · ranges ${stream.ranges}` : ""}
                </small>
              </span>
            </div>
          )}
          <video ref={videoRef} className="remux-video" controls playsInline />
        </div>
      )}

      {result && !result.acceptsRanges && result.redirected && (
        <div className="notice">
          <span>
            The request was redirected and the range was lost on the way. Try
            the resolved URL directly — if that returns 206, seeking works and
            only the redirect needs following first.
          </span>
          <button
            className="notice-action"
            onClick={() => {
              setUrl(result.finalUrl);
              setResult(null);
            }}
          >
            Use resolved URL
          </button>
        </div>
      )}

      {result && (
        <div className="setting-card">
          <header>
            <h2>Result</h2>
            <button className="secondary" onClick={() => void copyReport()}>
              {copied ? "Copied" : "Copy report"}
            </button>
          </header>
          <div className="info-row">
            <span>
              <strong>
                {result.acceptsRanges
                  ? "Range requests accepted"
                  : "No 206 — the host ignored the range, read was capped"}
              </strong>
              <small>
                HTTP {result.status}
                {result.acceptRangesHeader
                  ? ` · accept-ranges: ${result.acceptRangesHeader}`
                  : " · no accept-ranges header"}
                {result.redirected ? " · redirected" : ""} · read{" "}
                {(result.bytesRead / 1024).toFixed(0)} KB
                {result.totalBytes
                  ? ` of ${(result.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
                  : ""}{" "}
                in {elapsed} ms
              </small>
            </span>
          </div>
          {(() => {
            const plan = planRemux(result.tracks);
            return (
              <div className="info-row">
                <span>
                  <strong>
                    {plan.needsAudioTranscode
                      ? "Needs an audio transcode"
                      : "Remuxable as-is"}
                  </strong>
                  <small
                    className={
                      plan.needsAudioTranscode ? "probe-transcode" : "probe-ok"
                    }
                  >
                    {plan.summary} Would carry{" "}
                    {verdictFor(plan.video ?? { kind: "video", codecId: "" }).label}
                    {plan.audio
                      ? ` + ${verdictFor(plan.audio).label}${plan.audio.channels ? ` ${plan.audio.channels}ch` : ""}`
                      : ""}
                    {plan.subtitles.length
                      ? `, ${plan.subtitles.length} text subtitle${plan.subtitles.length === 1 ? "" : "s"}`
                      : ""}
                    {plan.droppedBitmapSubtitles
                      ? `, dropping ${plan.droppedBitmapSubtitles} bitmap subtitle${plan.droppedBitmapSubtitles === 1 ? "" : "s"}`
                      : ""}
                    .
                  </small>
                </span>
              </div>
            );
          })()}
          {scan &&
            scan.tracks.map((track) => {
              const frames = scan.frames.filter(
                (frame) => frame.track === track.number,
              );
              const keys = frames.filter((frame) => frame.keyframe).length;
              const times = frames.map((frame) => frame.timeMs);
              const span = times.length
                ? Math.max(...times) - Math.min(...times)
                : 0;
              const config = track.codecPrivate?.length ?? 0;
              // A track a remuxer would carry needs both: frames located, and
              // either decoder config or a codec whose config is synthesised.
              const usable = frames.length > 0;
              return (
                <div className="info-row" key={`scan-${track.number}`}>
                  <span>
                    <strong>
                      track {track.number} · {track.kind} · {track.codecId}
                    </strong>
                    <small className={usable ? "probe-ok" : "probe-blocked"}>
                      {frames.length} frames
                      {frames.length
                        ? ` · ${keys} key · ${(span / 1000).toFixed(2)}s · ${(frames.reduce((sum, frame) => sum + frame.size, 0) / 1024).toFixed(0)} KB`
                        : " — none in this range"}
                      {" · "}
                      {config
                        ? `${config} bytes of decoder config`
                        : "no CodecPrivate"}
                    </small>
                  </span>
                </div>
              );
            })}
          {scan && (
            <div className="info-row">
              <span>
                <strong>
                  {scan.frames.length} frames across {scan.clusters} cluster
                  {scan.clusters === 1 ? "" : "s"}
                </strong>
                <small className={scan.frames.length ? "probe-ok" : "probe-blocked"}>
                  {scan.frames.length === 0
                    ? "No frames located — the demuxer cannot read this layout."
                    : (() => {
                        const keys = scan.frames.filter((frame) => frame.keyframe);
                        const times = scan.frames.map((frame) => frame.timeMs);
                        const span = Math.max(...times) - Math.min(...times);
                        const config = scan.tracks.filter(
                          (track) => track.codecPrivate?.length,
                        ).length;
                        return `${keys.length} keyframes · ${(span / 1000).toFixed(2)}s spanned · ${config} track${config === 1 ? "" : "s"} carry decoder config · scale ${scan.timestampScaleNs / 1000}µs`;
                      })()}
                  {scan.truncated ? " · buffer ended mid-element" : ""}
                </small>
              </span>
            </div>
          )}
          {result.tracks.map((track, index) => {
            const verdict = verdictFor(track);
            return (
              <div className="info-row" key={`${track.codecId}:${index}`}>
                <span>
                  <strong>
                    {track.kind} · {verdict.label}
                    {track.width ? ` · ${track.width}×${track.height}` : ""}
                    {track.channels ? ` · ${track.channels}ch` : ""}
                    {track.language && track.language !== "und"
                      ? ` · ${track.language}`
                      : ""}
                  </strong>
                  <small className={`probe-${verdict.status}`}>
                    {verdict.detail} <code>{track.codecId}</code>
                  </small>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
