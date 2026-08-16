import assert from "node:assert/strict";
import test from "node:test";

import { parseAc3 } from "../src/lib/eac3.ts";
import {
  MatroskaStream,
  splitLacedPayload,
} from "../src/lib/matroskaStream.ts";
import {
  fragmentCutIndex,
  initialFragmentStartIndex,
} from "../src/lib/remuxFragments.ts";
import {
  shouldManuallyEvict,
  shouldPauseManagedBuffering,
  shouldPauseForRemuxQueue,
  shouldReportNoAppendProgress,
} from "../src/lib/remuxBufferPolicy.ts";
import { isMatroskaSource } from "../src/lib/playback.ts";
import {
  parseContentRange,
  partialResponseMatches,
  reachedDeclaredRangeEnd,
} from "../src/lib/httpRange.ts";

const bytes = (...frames) => Uint8Array.from(frames.flat());
const element = (id, payload) => {
  assert.ok(payload.length < 127);
  return bytes(id, [0x80 | payload.length], [...payload]);
};

test("splits Xiph-laced audio frames", () => {
  const payload = bytes(2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const frames = splitLacedPayload(payload, 0x02);
  assert.deepEqual(frames?.map((frame) => [...frame]), [
    [1, 2, 3],
    [4, 5, 6, 7],
    [8, 9],
  ]);
});

test("splits fixed-size lacing and rejects uneven payloads", () => {
  const frames = splitLacedPayload(bytes(2, 1, 2, 3, 4, 5, 6), 0x04);
  assert.deepEqual(frames?.map((frame) => [...frame]), [
    [1, 2],
    [3, 4],
    [5, 6],
  ]);
  assert.equal(splitLacedPayload(bytes(2, 1, 2, 3, 4, 5), 0x04), null);
});

test("splits EBML lacing with signed size deltas", () => {
  // Three frames: first size 3 (0x83), then +1 (one-byte signed 0xC0),
  // with the final size inferred from the remaining payload.
  const payload = bytes(2, 0x83, 0xc0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const frames = splitLacedPayload(payload, 0x06);
  assert.deepEqual(frames?.map((frame) => [...frame]), [
    [1, 2, 3],
    [4, 5, 6, 7],
    [8, 9],
  ]);
});

test("Matroska Duration uses TimestampScale regardless of child order", () => {
  const durationBytes = new Uint8Array(8);
  new DataView(durationBytes.buffer).setFloat64(0, 475_090);
  const duration = element([0x44, 0x89], durationBytes);
  const timestampScale = element([0x2a, 0xd7, 0xb1], [0x01, 0x86, 0xa0]);
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    Uint8Array.from([...duration, ...timestampScale]),
  );

  const stream = new MatroskaStream();
  stream.push(info);
  assert.equal(stream.timestampScaleNs, 100_000);
  assert.equal(stream.durationSeconds, 47.509);
});

test("AC-3 parsing skips crc1 before the decoder configuration fields", () => {
  const bits = [];
  const write = (value, count) => {
    for (let bit = count - 1; bit >= 0; bit -= 1)
      bits.push((value >> bit) & 1);
  };
  write(0x1234, 16); // crc1
  write(0, 2); // fscod: 48 kHz
  write(20, 6); // frmsizecod: bitrate code 10
  write(8, 5); // bsid
  write(3, 3); // bsmod
  write(2, 3); // acmod: stereo
  write(0, 2); // dsurmod
  write(1, 1); // lfeon
  while (bits.length % 8) bits.push(0);
  const header = [0x0b, 0x77];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index + bit];
    header.push(value);
  }

  const info = parseAc3(Uint8Array.from(header));
  assert.ok(info);
  assert.equal(info.eac3, false);
  assert.equal(info.sampleRate, 48_000);
  assert.equal(info.bsid, 8);
  assert.equal(info.bsmod, 3);
  assert.equal(info.acmod, 2);
  assert.equal(info.lfeon, 1);
  assert.equal(info.channels, 3);
  assert.equal(info.bitRateCode, 10);
});

test("strictly validates HTTP content ranges", () => {
  assert.deepEqual(parseContentRange("bytes 8388608-16777215/50000000"), {
    start: 8_388_608,
    end: 16_777_215,
    total: 50_000_000,
  });
  assert.deepEqual(parseContentRange("bytes 0-1/*"), {
    start: 0,
    end: 1,
    total: null,
  });
  assert.deepEqual(parseContentRange("bytes=0 - 1 / 500"), {
    start: 0,
    end: 1,
    total: 500,
  });
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange("bytes 9-2/100"), null);
  assert.equal(parseContentRange("bytes 0-100/100"), null);
});

test("a CORS-hidden Content-Range still permits an HTTP 206", () => {
  assert.equal(partialResponseMatches(206, null, 8_388_608), true);
  assert.equal(
    partialResponseMatches(206, "bytes 8388608-16777215/50000000", 8_388_608),
    true,
  );
  assert.equal(partialResponseMatches(206, "bytes 0-1/50000000", 8_388_608), false);
  assert.equal(partialResponseMatches(200, null, 0), false);
});

test("a retained HTTP 200 reader outranks its declared Content-Length", () => {
  assert.equal(reachedDeclaredRangeEnd(8_388_608, 2, true), false);
  assert.equal(reachedDeclaredRangeEnd(8_388_608, 2, false), true);
  assert.equal(reachedDeclaredRangeEnd(8_388_608, null, false), false);
});

test("continuous video fragments stay bounded even across a long GOP", () => {
  const frames = [
    { timeMs: 0, keyframe: true },
    { timeMs: 500, keyframe: false },
    { timeMs: 1000, keyframe: false },
    { timeMs: 1500, keyframe: false },
    { timeMs: 2000, keyframe: false },
    { timeMs: 2500, keyframe: true },
    { timeMs: 3000, keyframe: false },
    { timeMs: 5000, keyframe: true },
  ];
  assert.equal(fragmentCutIndex(frames, "video", false), 4);
  assert.equal(frames[4].keyframe, false);
});

test("only the first video fragment waits for a keyframe", () => {
  const continuation = [
    { timeMs: 2_000, keyframe: false },
    { timeMs: 2_500, keyframe: false },
    { timeMs: 3_000, keyframe: true },
  ];
  assert.equal(initialFragmentStartIndex(continuation, false), 2);
  assert.equal(initialFragmentStartIndex(continuation, true), 0);
  assert.equal(
    initialFragmentStartIndex(continuation.slice(0, 2), false),
    -1,
  );
});

test("high-bitrate fragments cut before one append becomes enormous", () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({
    timeMs: index * 100,
    keyframe: index === 0,
    data: { byteLength: 1_500_000 },
  }));
  assert.equal(fragmentCutIndex(frames, "video", false), 2);
});

test("audio fragments are bounded without requiring a keyframe", () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({
    timeMs: index * 500,
    keyframe: true,
  }));
  assert.equal(fragmentCutIndex(frames, "audio", false), 4);
});

test("Matroska routing recognizes filenames even when stream URLs hide extensions", () => {
  assert.equal(
    isMatroskaSource("https://media.example/opaque-token", "Episode.S01E01.mkv"),
    true,
  );
  assert.equal(
    isMatroskaSource(
      "https://media.example/opaque-token",
      "Episode.S01E01.mkv · 4K · 18 GB",
    ),
    true,
  );
  assert.equal(isMatroskaSource("https://media.example/movie.mp4"), false);
});

test("ManagedMediaSource is left to clean normal buffer pressure itself", () => {
  assert.equal(shouldManuallyEvict(true, true), false);
  assert.equal(shouldManuallyEvict(false, true), true);
  assert.equal(shouldManuallyEvict(true, true, true), true);
});

test("ManagedMediaSource demand pauses only while playable data remains", () => {
  assert.equal(shouldPauseManagedBuffering(true, false, 8), true);
  assert.equal(shouldPauseManagedBuffering(true, true, 8), false);
  assert.equal(shouldPauseManagedBuffering(true, false, 0.5), false);
  assert.equal(shouldPauseManagedBuffering(false, false, 8), false);
});

test("remux queue backpressure caps both bytes and fragment count", () => {
  assert.equal(shouldPauseForRemuxQueue(7, 2, 8, 4), false);
  assert.equal(shouldPauseForRemuxQueue(8, 2, 8, 4), true);
  assert.equal(shouldPauseForRemuxQueue(1, 4, 8, 4), true);
});

test("no-progress watchdog waits for every append path to become idle", () => {
  const threshold = 48 * 1024 * 1024;
  assert.equal(shouldReportNoAppendProgress(threshold + 1, false, 0), true);
  assert.equal(shouldReportNoAppendProgress(threshold + 1, true, 0), false);
  assert.equal(shouldReportNoAppendProgress(threshold + 1, false, 1), false);
  assert.equal(shouldReportNoAppendProgress(threshold, false, 0), false);
});
