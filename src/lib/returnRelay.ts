import type { ExternalPlayerReport } from "./externalHandoff";

/**
 * The relay that carries a position back into an installed iOS web app.
 *
 * Nothing else crosses that boundary. iOS reopens an installed web app at its
 * own start address and discards the query, and Safari — where a callback
 * lands — is a separate storage container, signed out and knowing nothing. So
 * the player's callback is pointed at a small service instead, which is the
 * first thing in the chain that ever sees the number, and the app collects it
 * from there on waking.
 *
 * Optional in every sense: with no relay configured the callbacks work as
 * before and the prompt asks. See worker/README.md.
 */

const TOKEN_KEY = "nuvio-web-return-token";

/** Where the relay runs. See worker/ for what it is and what it holds. */
export const RELAY_URL = "https://nuvio-return-relay.lucaboox.workers.dev";

/**
 * A fresh token per hand-off, 128 bits from the platform's own source.
 *
 * It is the only thing naming this playback anywhere outside the app, so it
 * has to be unguessable and it has to mean nothing on its own.
 */
export function newRelayToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing to collect later, and the prompt still asks.
  }
  return token;
}

export function pendingRelayToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearRelayToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // It expires at the relay regardless.
  }
}

/**
 * The address a player should return to. The relay needs to know which app to
 * send the viewer back to, and nothing else about the playback.
 */
export function relayReturnUrl(
  token: string,
  appAddress: string,
  outcome: "finished" | "stopped",
) {
  const query = new URLSearchParams({ outcome, app: appAddress });
  // The trailing fragment is the point of interest. A player appends its own
  // parameters to the end of whatever address it was handed, and a fragment is
  // never sent to a server — so if it appends plainly rather than parsing the
  // address first, the stream URL it appends alongside the position stays on
  // the device, and the relay page reads the position and posts that alone.
  // Where it does parse, the parameters land in the query as before and
  // nothing is worse than it was.
  return `${RELAY_URL}/r/${token}?${query.toString()}#nuvio`;
}

/**
 * Asks the relay whether an answer is waiting. Reading empties the slot, so
 * this is asked once per return and the token dropped either way.
 */
export async function collectRelayReport(
  token: string,
  signal?: AbortSignal,
): Promise<ExternalPlayerReport | null> {
  if (!token) return null;
  try {
    const response = await fetch(`${RELAY_URL}/c/${token}`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      found?: boolean;
      report?: {
        outcome?: string;
        positionMs?: number;
        durationMs?: number;
      };
    };
    const report = body.found ? body.report : undefined;
    if (!report) return null;
    if (report.outcome === "finished") return { outcome: "finished" };
    if (report.outcome === "stopped")
      return {
        outcome: "stopped",
        positionMs: Math.max(0, Math.round(report.positionMs ?? 0)),
        durationMs: Math.max(0, Math.round(report.durationMs ?? 0)),
      };
    return null;
  } catch {
    // A relay that cannot be reached is a prompt, not an error.
    return null;
  }
}
