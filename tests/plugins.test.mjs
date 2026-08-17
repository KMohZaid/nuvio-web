import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizePluginManifestUrl } from "../src/lib/pluginUrl.ts";

test("plugin repository URLs match Nuvio normalization and preserve configuration", () => {
  assert.equal(
    normalizePluginManifestUrl("plugins.example/repository?token=abc"),
    "https://plugins.example/repository/manifest.json?token=abc",
  );
  assert.equal(
    normalizePluginManifestUrl("https://plugins.example/manifest.json?user=1#old"),
    "https://plugins.example/manifest.json?user=1",
  );
  assert.throws(
    () => normalizePluginManifestUrl("https://user:secret@plugins.example"),
    /public HTTP or HTTPS/,
  );
});

test("plugin execution stays inside a disposable opaque frame", async () => {
  const [index, host, runtime] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/plugin-sandbox.html", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/plugins.ts", import.meta.url), "utf8"),
  ]);
  assert.match(host, /script-src 'unsafe-inline' 'unsafe-eval'/);
  assert.match(host, /\(0,eval\)\(data\.code\)/);
  assert.doesNotMatch(index, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(index, /script-src[^;]*'unsafe-eval'/);
  assert.match(runtime, /frame\.sandbox\.add\("allow-scripts"\)/);
  assert.doesNotMatch(runtime, /sandbox\.add\("allow-same-origin"\)/);
});

test("browser plugin execution is bounded and cannot send ambient credentials", async () => {
  const runtime = await readFile(
    new URL("../src/lib/plugins.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /const PLUGIN_TIMEOUT_MS = 15_000/);
  assert.match(runtime, /const PLUGIN_FETCH_TIMEOUT_MS = 10_000/);
  assert.match(runtime, /credentials: "omit"/);
  assert.match(runtime, /globalThis\.fetch = async function/);
  assert.match(runtime, /replace\(\/\\\\\/\?\$\//);
});

test("web plugin execution is locked off at the runtime boundary", async () => {
  const runtime = await readFile(
    new URL("../src/lib/plugins.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /export const WEB_PLUGINS_SUPPORTED = false/);
  assert.match(
    runtime,
    /if \(!WEB_PLUGINS_SUPPORTED \|\| !state\.pluginsEnabled\) return \[\]/,
  );
});
