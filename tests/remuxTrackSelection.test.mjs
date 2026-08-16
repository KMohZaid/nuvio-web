import assert from "node:assert/strict";
import test from "node:test";
import { selectRemuxTrackPair } from "../src/lib/remuxTrackSelection.ts";

test("remux selects a compatible alternate when lossless audio is first", () => {
  const pair = selectRemuxTrackPair([
    { id: 1, type: "video", codec: "avc", language: "und", primary: true },
    { id: 2, type: "audio", codec: null, language: "en", primary: true },
    { id: 3, type: "audio", codec: "eac3", language: "en", primary: false },
  ]);

  assert.deepEqual(pair, { videoId: 1, audioId: 3 });
});

test("remux audio selection honors Nuvio's preferred language", () => {
  const pair = selectRemuxTrackPair(
    [
      { id: 1, type: "video", codec: "hevc", language: "und", primary: true },
      { id: 2, type: "audio", codec: "aac", language: "en", primary: true },
      { id: 3, type: "audio", codec: "aac", language: "spa", primary: false },
    ],
    "es",
    "en-US",
  );

  assert.deepEqual(pair, { videoId: 1, audioId: 3 });
});
