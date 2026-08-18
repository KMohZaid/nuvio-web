import assert from "node:assert/strict";
import test from "node:test";
import { chooseAudioTrack } from "../src/lib/mediabunnyPlayer.ts";

// The case that sent this back: a release whose first audio track is French,
// which plays French to an English viewer unless the language is asked for.
test("a preferred language wins over the file's ordering", () => {
  assert.equal(chooseAudioTrack(["fre", "eng"], ["en"]), 1);
  assert.equal(chooseAudioTrack(["fre", "ger", "eng"], ["en"]), 2);
});

test("preferences are tried in order", () => {
  assert.equal(chooseAudioTrack(["fre", "ger", "eng"], ["ja", "de", "en"]), 1);
});

test("regional and three-letter tags are the same request", () => {
  assert.equal(chooseAudioTrack(["fre", "en-GB"], ["en-US"]), 1);
  assert.equal(chooseAudioTrack(["fre", "eng"], ["en_us"]), 1);
});

test("no match leaves the file's own first track alone", () => {
  assert.equal(chooseAudioTrack(["fre", "ger"], ["en"]), 0);
  assert.equal(chooseAudioTrack(["fre", "ger"], []), 0);
  // An untagged track is not a match for anything, but is still the fallback.
  assert.equal(chooseAudioTrack(["", ""], ["en"]), 0);
});

test("the first match wins when a language appears twice", () => {
  assert.equal(chooseAudioTrack(["eng", "eng"], ["en"]), 0);
});

// Matroska tags in ISO 639-2 and people ask in 639-1, and the two coincide
// only by accident. Truncating "ger" gives "ge", which matches nothing.
test("three-letter codes map to the language, not their first two letters", () => {
  assert.equal(chooseAudioTrack(["eng", "ger"], ["de"]), 1);
  assert.equal(chooseAudioTrack(["eng", "spa"], ["es"]), 1);
  assert.equal(chooseAudioTrack(["eng", "jpn"], ["ja"]), 1);
  assert.equal(chooseAudioTrack(["eng", "dut"], ["nl"]), 1);
  assert.equal(chooseAudioTrack(["eng", "chi"], ["zh"]), 1);
  // And the alternative three-letter set for the same languages.
  assert.equal(chooseAudioTrack(["eng", "deu"], ["de"]), 1);
  assert.equal(chooseAudioTrack(["eng", "fra"], ["fr"]), 1);
});

// The case that sent this back a second time: a disc rip leading with an
// Atmos/TrueHD track nothing in a browser decodes, followed by the AC-3 mix
// that everything does. Both are English, so language alone chooses silence.
test("an undecodable track is never chosen, whatever language it claims", () => {
  assert.equal(
    chooseAudioTrack(["eng", "eng"], ["en"], [false, true]),
    1,
  );
  assert.equal(
    chooseAudioTrack(["eng", "fre", "eng"], ["en"], [false, true, true]),
    2,
  );
});

test("language still decides among the tracks that can be played", () => {
  assert.equal(
    chooseAudioTrack(["fre", "eng", "ger"], ["de"], [true, true, true]),
    2,
  );
});

test("with no preferred language the first playable track wins", () => {
  assert.equal(chooseAudioTrack(["eng", "eng"], [], [false, true]), 1);
  assert.equal(chooseAudioTrack(["fre", "ger"], ["ja"], [false, true]), 1);
});

test("nothing playable falls back rather than throwing", () => {
  assert.equal(chooseAudioTrack(["eng", "fre"], ["en"], [false, false]), 0);
});
