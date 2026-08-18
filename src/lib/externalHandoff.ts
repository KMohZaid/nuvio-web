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

const LOG_KEY = "nuvio-web-return-log";

/**
 * A short log of how the app was last reopened.
 *
 * A log rather than a single reading, because the question is a sequence: a
 * test goes out, and either something comes back seconds later or the next
 * entry is a person reopening the app minutes afterwards. One line cannot
 * tell those apart — the flag saying an answer is owed is consumed by
 * whichever open happens first, whether or not it was the answer.
 *
 * Kept because this route cannot be watched from here. It runs through two
 * other apps and ends on a device with no console, so the phone has to be able
 * to answer the question itself.
 */
const LOG_LIMIT = 6;
const TEST_KEY = "nuvio-web-test-sent-at";
/** Long enough to cover a slow hop, short enough not to colour a later visit. */
const TEST_WINDOW_MS = 5 * 60 * 1000;

/** Local time: this is read on the device, against its own clock. */
function clockTime() {
  return new Date().toLocaleTimeString();
}

export function readExternalReturnLog(): string[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function append(line: string) {
  try {
    const log = [`${clockTime()} ${line}`, ...readExternalReturnLog()];
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_LIMIT)));
  } catch {
    // Only the diagnostic is lost.
  }
}

/** Adds a line the address bar could not have told us, such as a relay's answer. */
export function noteExternalEvent(line: string) {
  append(line);
}

/**
 * Notes that a test has gone out, so arrivals for the next few minutes are
 * logged whatever they carry — and so a test that never comes back is visible
 * as an entry with nothing after it.
 */
export function expectExternalReturn() {
  try {
    localStorage.setItem(TEST_KEY, String(Date.now()));
  } catch {
    // The window is lost; arrivals carrying parameters are still logged.
  }
  append("test sent");
}

export function noteExternalReturn(reason: string) {
  if (typeof window === "undefined") return;
  let sentAt = 0;
  try {
    sentAt = Number(localStorage.getItem(TEST_KEY) ?? 0);
  } catch {
    // Treated as no test outstanding.
  }
  // The window is not consumed by the first arrival: an open that is not the
  // answer must not stop the answer from being logged when it does come.
  const testing = sentAt > 0 && Date.now() - sentAt < TEST_WINDOW_MS;
  const pending = !!readExternalHandoff();
  // Otherwise every ordinary open would fill the log with nothing.
  if (!window.location.search && !testing && !pending) return;
  const why = testing
    ? "after test"
    : window.location.search
      ? "with parameters"
      : "while awaiting a player";
  // The path as well as the query: an installed web app reopened at its
  // start_url rather than at the address it was given is a different failure
  // from one reopened correctly with the query stripped.
  append(
    `${reason} ${why} · ${window.location.pathname}${
      window.location.search || " (no parameters)"
    }`,
  );
}

/**
 * Reads a report out of any address, wherever it was found.
 *
 * The address bar is one source. On an installed iOS web app it is never the
 * source: webapp:// opens the app at its start_url and discards the path and
 * query it was given — the Shortcut receives the full address intact and the
 * app still wakes at "/" with nothing. So the same address also arrives by
 * clipboard, and is read the same way.
 */
export function parseExternalReport(
  address: string,
): ExternalPlayerReport | null {
  const query = address.includes("?")
    ? address.slice(address.indexOf("?"))
    : address;
  const params = new URLSearchParams(query);
  const outcome = params.get("nuvio-external");
  if (outcome !== "finished" && outcome !== "stopped") return null;
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

/** Reads the report out of the address bar and takes it back out again. */
export function takeExternalReport(): ExternalPlayerReport | null {
  if (typeof window === "undefined") return null;
  const report = parseExternalReport(window.location.search);
  if (!report) return null;

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
  return report;
}
