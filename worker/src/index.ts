/**
 * Carries a playback position across the one boundary nothing else crosses.
 *
 * An installed iOS web app cannot be reached by URL. iOS opens it at its own
 * start address and discards the path and query, and Safari — where a player's
 * callback lands — is a separate storage container that is signed out and
 * knows nothing. So a player can say exactly where it stopped and there is no
 * way for that number to reach the app.
 *
 * This is the relay. A player's callback comes here as an ordinary HTTP
 * request, which is the first and only point in the chain that sees the
 * number. It is held under a token the app generated before playback, and
 * handed back when the app asks for it.
 *
 * What it never receives: what is being watched, the stream, the addon, the
 * account. A token and a number of seconds is the whole of it, and both are
 * deleted on collection or after a few minutes unread.
 */

export interface Env {
  RETURN_SLOT: DurableObjectNamespace;
  /** Public hosts the app may be reached at, comma separated. */
  ALLOWED_APP_HOSTS: string;
  /**
   * Further hosts, kept out of the repository. A private instance's address is
   * not a secret in the cryptographic sense — a certificate puts it in the
   * public transparency logs the day it is issued — but there is no reason to
   * publish it either, and a secret keeps it out of a public config file.
   */
  EXTRA_APP_HOSTS?: string;
  /** The Shortcut to run, which must match the one installed on the device. */
  SHORTCUT_NAME: string;
}

/** Held only until collected, and no longer than this if it never is. */
const MAX_AGE_MS = 5 * 60 * 1000;

type Report = {
  outcome: "finished" | "stopped";
  positionMs: number;
  durationMs: number;
  at: number;
  /**
   * Where the player put its parameters, which decides whether the stream URL
   * beside them was ever sent here. Recorded so the app can say so long after
   * the page that observed it has gone.
   */
  via: "query" | "fragment";
};

/**
 * One slot, one token.
 *
 * A Durable Object rather than KV because the write and the read are seconds
 * apart, sometimes less: a player posts here and the app asks immediately on
 * waking. KV is eventually consistent and would hand back the previous answer
 * or none at all.
 */
export class ReturnSlot {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/put") {
      const report = (await request.json()) as Report;
      await this.state.storage.put("report", report);
      // A slot nobody collects must not outlive its usefulness.
      await this.state.storage.setAlarm(Date.now() + MAX_AGE_MS);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/take") {
      const report = await this.state.storage.get<Report>("report");
      // Read once: collecting is the end of this token's life either way.
      await this.state.storage.deleteAll();
      if (!report || Date.now() - report.at > MAX_AGE_MS)
        return Response.json({ found: false });
      return Response.json({ found: true, report });
    }
    return new Response("Not found", { status: 404 });
  }

  /** Nothing to collect any more; forget it rather than keep it. */
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

/** A token is opaque and fixed width — anything else is not one of ours. */
const isToken = (value: string) => /^[0-9a-f]{32}$/.test(value);

const seconds = (value: string | null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : 0;
};

function allowedHosts(env: Env) {
  return `${env.ALLOWED_APP_HOSTS},${env.EXTRA_APP_HOSTS ?? ""}`
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The app asking for its own answer, from a page it serves. Only the hosts
 * this relay was configured for may read anything back.
 */
function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("Origin") ?? "";
  let host = "";
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
  if (!allowedHosts(env).includes(host)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

/**
 * Sends the viewer onward to the app.
 *
 * Safari will not open webapp:// itself, so the hop goes through Shortcuts,
 * which will. The redirect is attempted immediately and a button offered
 * behind it, because a scheme handoff without a tap is not something every
 * iOS version allows.
 */
function handoffPage(appAddress: string, shortcutName: string, token: string) {
  // Host and path both: a project site lives under /<repo>/, and webapp://
  // opens the app installed from exactly one address. The trailing slash is
  // required — without it iOS finds nothing.
  const target = `webapp://${appAddress.replace(/\/*$/, "/")}`;
  const shortcut =
    `shortcuts://run-shortcut?` +
    new URLSearchParams({ name: shortcutName, input: "text", text: target })
      .toString()
      .replaceAll("+", "%20");
  const escaped = shortcut.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Returning to Nuvio</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;min-height:100vh;display:grid;place-items:center;gap:18px;
      background:#080a0d;color:#e9eef2;font:16px/1.5 -apple-system,system-ui,sans-serif;
      text-align:center;padding:24px}
 a{display:inline-block;padding:14px 22px;border-radius:12px;background:#e9eef2;
   color:#090b0d;text-decoration:none;font-weight:600}
 p{color:#8d97a2;margin:0}
 small{color:#5d666f;font-size:11px}
</style></head>
<body><div>
 <p>Saved where you stopped.</p>
 <p><a id="go" href="${escaped}">Return to Nuvio</a></p>
 <p><small id="via"></small></p>
</div>
<script>
// A fragment never leaves the browser. If the player appended its parameters
// after the "#" we put on the end of this address, then the stream URL it
// appends alongside them was never sent here — and the position is read out of
// the fragment and posted back on its own, without it.
(async function () {
  var hash = location.hash.replace(/^#nuvio&?/, "");
  var read = new URLSearchParams(hash);
  var pos = read.get("position");
  var via = document.getElementById("via");
  if (pos !== null) {
    try {
      await fetch(${JSON.stringify(`/p/${token}`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: pos, duration: read.get("duration") })
      });
      via.textContent = "Position read on this device; the stream URL was never sent.";
    } catch (e) {
      via.textContent = "Could not save the position.";
    }
  } else {
    via.textContent = "Position arrived in the address.";
  }
  location.href = document.getElementById("go").href;
})();
</script>
</body></html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [route, token] = url.pathname.split("/").filter(Boolean);
    if (!token || !isToken(token))
      return new Response("Not found", { status: 404 });
    const slot = env.RETURN_SLOT.get(env.RETURN_SLOT.idFromName(token));

    // A player finishing up. This is an ordinary browser navigation, so the
    // answer is a page rather than a status.
    if (route === "r") {
      const outcome = url.searchParams.get("outcome");
      if (outcome !== "finished" && outcome !== "stopped")
        return new Response("Not found", { status: 404 });
      // "host" or "host/path/" — only the host is checked against the list,
      // and the path is carried through so a project site is reopened at the
      // address it was installed from rather than at the domain root.
      const app = (url.searchParams.get("app") ?? "").toLowerCase();
      if (!allowedHosts(env).includes(app.split("/")[0] ?? ""))
        return new Response("Unknown app", { status: 400 });
      const report: Report = {
        outcome,
        positionMs: seconds(url.searchParams.get("position")),
        durationMs: seconds(url.searchParams.get("duration")),
        at: Date.now(),
        // A position in the query means the player parsed the address and put
        // everything there, the stream URL included. Absent, it went after the
        // fragment and the page will post it back on its own.
        via: url.searchParams.has("position") ? "query" : "fragment",
      };
      // Stored even when empty: the outcome is known either way, and the page
      // fills in the numbers afterwards when they came back in the fragment.
      await slot.fetch("https://slot/put", {
        method: "POST",
        body: JSON.stringify(report),
      });
      return new Response(handoffPage(app, env.SHORTCUT_NAME, token), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The player's parameters are in this address; keep it out of
          // history and out of any referrer.
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      });
    }

    // The handoff page, posting numbers it read out of the fragment — which
    // means they, and the stream URL beside them, never reached this server in
    // the request line. Same origin, so no CORS to negotiate.
    if (route === "p" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        position?: string;
        duration?: string;
      } | null;
      if (!body) return new Response("Bad request", { status: 400 });
      const answer = await slot.fetch("https://slot/take");
      const existing = (await answer.json()) as { report?: Report };
      await slot.fetch("https://slot/put", {
        method: "POST",
        body: JSON.stringify({
          outcome: existing.report?.outcome ?? "stopped",
          positionMs: seconds(body.position ?? null),
          durationMs: seconds(body.duration ?? null),
          at: Date.now(),
          via: "fragment",
        } satisfies Report),
      });
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    // The app collecting its answer.
    if (route === "c") {
      const cors = corsHeaders(request, env);
      if (!cors) return new Response("Not allowed", { status: 403 });
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      const answer = await slot.fetch("https://slot/take");
      return new Response(await answer.text(), {
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
