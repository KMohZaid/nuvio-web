import assert from "node:assert/strict";
import test from "node:test";
import { parseExternalReport } from "../src/lib/externalHandoff.ts";

// What the Shortcut copies is the whole webapp:// address, so the parser is
// given a full URL rather than a query — iOS reopens an installed web app at
// its own start address, so this is the only copy that still has the numbers.
const COPIED = "webapp://nuvioweb.lucaboox.win/?nuvio-external=stopped&position=83&duration=5400";

test("a stopped report is read out of the address the Shortcut copied", () => {
  assert.deepEqual(parseExternalReport(COPIED), {
    outcome: "stopped",
    positionMs: 83_000,
    durationMs: 5_400_000,
  });
});

test("a finished report needs no numbers", () => {
  assert.deepEqual(
    parseExternalReport("webapp://host/?nuvio-external=finished"),
    { outcome: "finished" },
  );
});

test("a bare query is read the same as a whole address", () => {
  assert.deepEqual(parseExternalReport("?nuvio-external=stopped&position=12"), {
    outcome: "stopped",
    positionMs: 12_000,
    durationMs: 0,
  });
});

test("anything else on the clipboard is refused rather than half-read", () => {
  for (const text of [
    "",
    "https://example.com/movie.mkv",
    "webapp://host/",
    "just some copied text",
    "?position=83&duration=5400",
  ])
    assert.equal(parseExternalReport(text), null, `should refuse: ${text}`);
});

test("a missing or nonsense position reads as no position, not NaN", () => {
  const report = parseExternalReport("?nuvio-external=stopped&position=abc");
  assert.deepEqual(report, { outcome: "stopped", positionMs: 0, durationMs: 0 });
});
