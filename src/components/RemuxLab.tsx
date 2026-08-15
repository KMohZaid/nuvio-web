import { useState } from "react";
import {
  mediaSourceSupport,
  planRemux,
  probeMatroska,
  verdictFor,
  type ProbeResult,
} from "../lib/matroska";

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
    const started = performance.now();
    try {
      const probe = await probeMatroska(url.trim());
      setResult(probe);
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
                Read {(result.bytesRead / 1024).toFixed(0)} KB
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
