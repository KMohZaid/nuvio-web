import type { Meta, Video } from "../types";

/**
 * A breadcrumb left behind when a stream is handed to another player.
 *
 * Launching one is a top-level navigation, and Android will happily kill a
 * backgrounded PWA outright while the other app has the screen. Either way
 * coming back is a cold start: the picker asks who is watching, the title that
 * was open is gone, and so is the prompt that was the only way to record where
 * the other player got to.
 *
 * This is what puts all three back. It is deliberately narrow — only a return
 * from a hand-off skips the picker, so opening the app normally still asks.
 */
const KEY = "nuvio-external-handoff";

/** Long enough for a film with interruptions, short enough not to resume yesterday. */
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type ExternalHandoff = {
  profileIndex: number;
  at: number;
  meta: Meta;
  video?: Video;
};

export function rememberExternalHandoff(
  profileIndex: number,
  meta: Meta,
  video?: Video,
) {
  try {
    const payload: ExternalHandoff = {
      profileIndex,
      at: Date.now(),
      // The episode list is re-fetched from the addon on the way back and is
      // far and away the biggest thing here — a long-running series would put
      // this near the storage quota on its own.
      meta: { ...meta, videos: [] },
      video,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // A blocked or full store costs the resume, never the hand-off itself.
  }
}

/** The pending hand-off, or null when there is none worth resuming. */
export function readExternalHandoff(): ExternalHandoff | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as ExternalHandoff;
    if (!value?.meta?.id || typeof value.profileIndex !== "number") return null;
    if (Date.now() - (value.at ?? 0) > MAX_AGE_MS) {
      clearExternalHandoff();
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function clearExternalHandoff() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — a stale entry ages out by itself.
  }
}

/**
 * What the other player reported on its way back.
 *
 * Only Outplayer says anything: its x-success and x-cancel callbacks reopen us
 * with the outcome, and x-cancel appends where it stopped and how long the
 * video was. That is exactly what the prompt would otherwise have to ask, so
 * when this is present the prompt is skipped and the position simply saved.
 */
export type ExternalPlayerReport =
  | { outcome: "finished" }
  | { outcome: "stopped"; positionMs: number; durationMs: number };

const LAST_RETURN_KEY = "nuvio-web-last-return";

/**
 * What the address bar held when the app was last reopened by a player.
 *
 * Kept because the route it travels cannot be watched from here: it runs
 * through another app, and on the device where that matters there is no
 * console to read. Settings shows it, so whether a position ever arrives is a
 * question the phone can answer.
 */
export function lastExternalReturn(): string {
  try {
    return localStorage.getItem(LAST_RETURN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Reads the report out of the address bar and takes it back out again. */
export function takeExternalReport(): ExternalPlayerReport | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("nuvio-external");
  if (outcome !== "finished" && outcome !== "stopped") return null;
  try {
    localStorage.setItem(
      LAST_RETURN_KEY,
      `${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${
        window.location.search || "(no parameters)"
      }`,
    );
  } catch {
    // Only the diagnostic is lost.
  }

  // The parameters are the player's, and they should not survive a refresh or
  // end up in a shared link.
  const clean = new URL(window.location.href);
  for (const key of [
    "nuvio-external",
    "url",
    "position",
    "duration",
    "errorCode",
    "errorMessage",
  ])
    clean.searchParams.delete(key);
  window.history.replaceState(null, "", clean.toString());

  if (outcome === "finished") return { outcome: "finished" };
  // Both are reported in seconds, and a fractional position is normal.
  const seconds = (value: string | null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : 0;
  };
  return {
    outcome: "stopped",
    positionMs: seconds(params.get("position")),
    durationMs: seconds(params.get("duration")),
  };
}
