import assert from "node:assert/strict";
import test from "node:test";
import { infusePlaybackUrl, shortcutReturnUrl } from "../src/lib/externalPlayer.ts";

test("Infuse handoff encodes signed stream URLs and a useful filename", () => {
  const result = infusePlaybackUrl(
    "https://media.example/movie.mkv?token=a+b&part=1",
    "House / Dragon: S1E1",
  );
  const parsed = new URL(result);

  assert.equal(parsed.protocol, "infuse:");
  assert.equal(parsed.pathname, "/play");
  assert.equal(
    parsed.searchParams.get("url"),
    "https://media.example/movie.mkv?token=a+b&part=1",
  );
  assert.equal(parsed.searchParams.get("filename"), "House _ Dragon_ S1E1.mkv");
});

test("the Shortcut return address keeps the trailing slash and a literal space", () => {
  const url = shortcutReturnUrl(
    "https://nuvio.example/",
    "?nuvio-external=stopped",
  );
  assert.ok(url.startsWith("shortcuts://run-shortcut?"));
  // "+" would be read as a plus by anything not decoding a form, and the name
  // has to match the installed Shortcut exactly.
  assert.ok(!url.includes("+"));
  assert.ok(url.includes("name=Open%20Nuvio"));
  const params = new URLSearchParams(url.split("?").slice(1).join("?"));
  assert.equal(params.get("name"), "Open Nuvio");
  assert.equal(
    params.get("text"),
    "webapp://nuvio.example/?nuvio-external=stopped",
  );
});

test("the Shortcut return address follows wherever the app is served from", () => {
  const pages = new URLSearchParams(
    shortcutReturnUrl("https://lucaboox.github.io/nuvio-web/", "?nuvio-external=finished")
      .split("?").slice(1).join("?"),
  );
  assert.equal(
    pages.get("text"),
    "webapp://lucaboox.github.io/nuvio-web/?nuvio-external=finished",
  );
  // A missing trailing slash is added: without it iOS does not find the app.
  const bare = new URLSearchParams(
    shortcutReturnUrl("https://example.com", "?nuvio-external=stopped")
      .split("?").slice(1).join("?"),
  );
  assert.equal(bare.get("text"), "webapp://example.com/?nuvio-external=stopped");
});
