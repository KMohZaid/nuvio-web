import assert from "node:assert/strict";
import test from "node:test";
import { infusePlaybackUrl } from "../src/lib/externalPlayer.ts";

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
