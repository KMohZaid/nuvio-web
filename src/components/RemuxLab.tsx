import { useState } from "react";
import {
  mediaSourceSupport,
  planRemux,
  probeMatroska,
  verdictFor,
  type ProbeResult,
} from "../lib/matroska";
import { scanBlocks, type BlockScan } from "../lib/matroskaBlocks";

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
