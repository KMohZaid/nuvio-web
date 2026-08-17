import assert from "node:assert/strict";
import test from "node:test";
import {
  selectBrowserRemuxPlan,
  selectRemuxTrackPair,
} from "../src/lib/remuxTrackSelection.ts";

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

test("browser remux uses an exact supported H.264 and AAC pair", () => {
  const checked = [];
  const plan = selectBrowserRemuxPlan(
    [
      {
        id: 1,
        type: "video",
        codec: "avc",
        codecParameter: "avc1.640028",
        language: "und",
        primary: true,
      },
      {
        id: 2,
        type: "audio",
        codec: "eac3",
        codecParameter: "ec-3",
        language: "en",
        primary: true,
      },
      {
        id: 3,
        type: "audio",
        codec: "aac",
        codecParameter: "mp4a.40.2",
        language: "en",
        primary: false,
      },
    ],
    "en",
    "en-US",
    (mime) => {
      checked.push(mime);
      return mime.includes("mp4a.40.2");
    },
  );

  assert.deepEqual(plan, {
    videoId: 1,
    audioId: 3,
    transcodeAudio: false,
    mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  });
  assert.deepEqual(checked, [
    'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  ]);
});

test("browser remux converts E-AC-3-only audio to AAC", () => {
  const plan = selectBrowserRemuxPlan(
    [
      {
        id: 1,
        type: "video",
        codec: "avc",
        codecParameter: "avc1.4d4028",
        language: "und",
        primary: true,
      },
      {
        id: 2,
        type: "audio",
        codec: "eac3",
        codecParameter: "ec-3",
        language: "en",
        primary: true,
      },
    ],
    "device",
    "en-US",
    (mime) => mime.includes("mp4a.40.2"),
  );

  assert.deepEqual(plan, {
    videoId: 1,
    audioId: 2,
    transcodeAudio: true,
    mime: 'video/mp4; codecs="avc1.4d4028,mp4a.40.2"',
  });
});

test("browser remux rejects a video codec profile MSE cannot consume", () => {
  const plan = selectBrowserRemuxPlan(
    [
      {
        id: 1,
        type: "video",
        codec: "hevc",
        codecParameter: "hvc1.2.4.L153.B0",
        language: "und",
        primary: true,
      },
      {
        id: 2,
        type: "audio",
        codec: "eac3",
        codecParameter: "ec-3",
        language: "en",
        primary: true,
      },
    ],
    "en",
    "en-US",
    () => false,
  );

  assert.deepEqual(plan, {
    videoId: null,
    audioId: null,
    transcodeAudio: false,
    mime: "",
  });
});
