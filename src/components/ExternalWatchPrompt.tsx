import { useState } from "react";
import type { Meta, Video } from "../types";

/**
 * Asks what happened after a stream was handed to another player.
 *
 * Nothing reports back from VLC, so a title watched externally would otherwise
 * leave no trace — no resume point, nothing marked watched, and Continue
 * Watching stuck showing an episode you already finished. This is the manual
 * substitute for the progress the internal player reports on its own.
 */
const HOUR = 3600;

/** Accepts `mm:ss`, `h:mm:ss`, or a plain minute count. */
export function parseTimecode(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,2}(:\d{1,2}){0,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 1) return parts[0]! * 60;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]! * HOUR + parts[1]! * 60 + parts[2]!;
}

/** Minutes from `Video.runtime` (a number) or `Meta.runtime` ("142 min"). */
export function runtimeMinutes(meta: Meta, video?: Video): number | null {
  if (typeof video?.runtime === "number" && video.runtime > 0)
    return video.runtime;
  const text = meta.runtime ?? "";
  const hours = /(\d+)\s*h/i.exec(text);
  const mins = /(\d+)\s*m/i.exec(text);
  const total = (Number(hours?.[1] ?? 0) * 60) + Number(mins?.[1] ?? 0);
  if (total > 0) return total;
  const bare = /^\s*(\d+)\s*$/.exec(text);
  return bare ? Number(bare[1]) : null;
}

const formatMinutes = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

export function ExternalWatchPrompt({
  meta,
  video,
  onFinished,
  onStopped,
  onDismiss,
}: {
  meta: Meta;
  video?: Video;
  onFinished(): void;
  onStopped(positionMs: number, durationMs: number): void;
  onDismiss(): void;
}) {
  const known = runtimeMinutes(meta, video);
  const [partial, setPartial] = useState(false);
  const [stoppedAt, setStoppedAt] = useState("");
  const [total, setTotal] = useState(known ? formatMinutes(known) : "");
  const [error, setError] = useState("");

  const save = () => {
    const position = parseTimecode(stoppedAt);
    const duration = parseTimecode(total);
    if (position == null) {
      setError("Enter a time like 24:10 or 1:24:10.");
      return;
    }
    // A resume point needs a duration: progress is stored as a fraction, and
    // without one the card cannot show how far through you are.
    if (duration == null || duration <= 0) {
      setError("Enter the total length so the position means something.");
      return;
    }
    if (position >= duration) {
      setError("That is past the end — use “I finished it” instead.");
      return;
    }
    onStopped(position * 1000, duration * 1000);
  };

  return (
    <div className="sheet-backdrop" onClick={onDismiss}>
      <section
        className="watch-prompt"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">EXTERNAL PLAYER</span>
        <h2>{video?.title || meta.name}</h2>
        <p>
          Nothing reports back from an external player, so tell Nuvio what
          happened and it will sync like any other playback.
        </p>
        {partial ? (
          <>
            <div className="watch-prompt-fields">
              <label>
                Stopped at
                <input
                  autoFocus
                  inputMode="numeric"
                  placeholder="24:10"
                  value={stoppedAt}
                  onChange={(event) => setStoppedAt(event.target.value)}
                />
              </label>
              <label>
                Total length
                <input
                  inputMode="numeric"
                  placeholder="48:00"
                  value={total}
                  onChange={(event) => setTotal(event.target.value)}
                />
              </label>
            </div>
            {error && <div className="notice error">{error}</div>}
            <div className="watch-prompt-actions">
              <button className="secondary" onClick={() => setPartial(false)}>
                Back
              </button>
              <button className="primary" onClick={save}>
                Save position
              </button>
            </div>
          </>
        ) : (
          <div className="watch-prompt-actions">
            <button className="secondary" onClick={onDismiss}>
              Not now
            </button>
            <button className="secondary" onClick={() => setPartial(true)}>
              I stopped partway
            </button>
            <button className="primary" onClick={onFinished}>
              I finished it
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
