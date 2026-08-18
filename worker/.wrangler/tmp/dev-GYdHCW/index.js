var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var MAX_AGE_MS = 5 * 60 * 1e3;
var ReturnSlot = class {
  constructor(state) {
    this.state = state;
  }
  state;
  static {
    __name(this, "ReturnSlot");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/put") {
      const report = await request.json();
      await this.state.storage.put("report", report);
      await this.state.storage.setAlarm(Date.now() + MAX_AGE_MS);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/take") {
      const report = await this.state.storage.get("report");
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
};
var isToken = /* @__PURE__ */ __name((value) => /^[0-9a-f]{32}$/.test(value), "isToken");
var seconds = /* @__PURE__ */ __name((value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1e3) : 0;
}, "seconds");
function allowedHosts(env) {
  return env.ALLOWED_APP_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}
__name(allowedHosts, "allowedHosts");
function corsHeaders(request, env) {
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
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function handoffPage(appHost, shortcutName) {
  const target = `webapp://${appHost}/`;
  const shortcut = `shortcuts://run-shortcut?` + new URLSearchParams({ name: shortcutName, input: "text", text: target }).toString().replaceAll("+", "%20");
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
</style></head>
<body><div>
 <p>Saved where you stopped.</p>
 <p><a id="go" href="${escaped}">Return to Nuvio</a></p>
</div>
<script>location.href=document.getElementById("go").href<\/script>
</body></html>`;
}
__name(handoffPage, "handoffPage");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [route, token] = url.pathname.split("/").filter(Boolean);
    if (!token || !isToken(token))
      return new Response("Not found", { status: 404 });
    const slot = env.RETURN_SLOT.get(env.RETURN_SLOT.idFromName(token));
    if (route === "r") {
      const outcome = url.searchParams.get("outcome");
      if (outcome !== "finished" && outcome !== "stopped")
        return new Response("Not found", { status: 404 });
      const host = (url.searchParams.get("app") ?? "").toLowerCase();
      if (!allowedHosts(env).includes(host))
        return new Response("Unknown app", { status: 400 });
      const report = {
        outcome,
        positionMs: seconds(url.searchParams.get("position")),
        durationMs: seconds(url.searchParams.get("duration")),
        at: Date.now()
      };
      await slot.fetch("https://slot/put", {
        method: "POST",
        body: JSON.stringify(report)
      });
      return new Response(handoffPage(host, env.SHORTCUT_NAME), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The player's parameters are in this address; keep it out of
          // history and out of any referrer.
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store"
        }
      });
    }
    if (route === "c") {
      const cors = corsHeaders(request, env);
      if (!cors) return new Response("Not allowed", { status: 403 });
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      const answer = await slot.fetch("https://slot/take");
      return new Response(await answer.text(), {
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

// ../../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-2l8tyI/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../../AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-2l8tyI/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ReturnSlot,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
