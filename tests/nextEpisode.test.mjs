import assert from "node:assert/strict";
import test from "node:test";
import {
  hasEpisodeAired,
  pickBingeStream,
  resolveNextEpisode,
  shouldShowNextEpisode,
} from "../src/lib/nextEpisode.ts";

const ep = (season, episode, extra = {}) => ({
  id: `s${season}e${episode}`, season, episode, ...extra,
});

test("the next episode follows season then episode order", () => {
  const videos = [ep(1, 2), ep(2, 1), ep(1, 1)];
  assert.equal(resolveNextEpisode(videos, 1, 1).id, "s1e2");
  // Across a season boundary, which listing order alone would get wrong.
  assert.equal(resolveNextEpisode(videos, 1, 2).id, "s2e1");
  assert.equal(resolveNextEpisode(videos, 2, 1), null);
});

test("specials without numbering are not part of the run", () => {
  const videos = [ep(1, 1), { id: "special" }, ep(1, 2)];
  assert.equal(resolveNextEpisode(videos, 1, 1).id, "s1e2");
});

test("an episode not in the list has no next", () => {
  assert.equal(resolveNextEpisode([ep(1, 1)], 4, 9), null);
  assert.equal(resolveNextEpisode([ep(1, 1)], undefined, undefined), null);
});

test("an unaired episode is not offered", () => {
  const now = new Date(2026, 7, 18);
  assert.equal(hasEpisodeAired("2026-08-17", now), true);
  assert.equal(hasEpisodeAired("2026-08-18", now), true);
  assert.equal(hasEpisodeAired("2026-08-19", now), false);
  assert.equal(hasEpisodeAired("2026-12-01T20:00:00Z", now), false);
});

test("a missing or malformed date counts as aired", () => {
  const now = new Date(2026, 7, 18);
  for (const value of [undefined, "", "soon", "2026"])
    assert.equal(hasEpisodeAired(value, now), true, `should air: ${value}`);
});

test("the card appears at the threshold, not before", () => {
  assert.equal(shouldShowNextEpisode(96_000, 100_000), false);
  assert.equal(shouldShowNextEpisode(97_000, 100_000), true);
  // Clamped to 97 at the low end, so the card cannot cover the episode.
  assert.equal(shouldShowNextEpisode(90_000, 100_000, 50), false);
  assert.equal(shouldShowNextEpisode(0, 100_000), false);
  assert.equal(shouldShowNextEpisode(50_000, 0), false);
});

test("the binge group keeps the same source across episodes", () => {
  const streams = [
    { url: "a", behaviorHints: { bingeGroup: "other" } },
    { url: "b", behaviorHints: { bingeGroup: "mine" } },
  ];
  assert.equal(pickBingeStream(streams, "mine").url, "b");
  // No group, or one that is gone, falls back to the first playable source.
  assert.equal(pickBingeStream(streams).url, "a");
  assert.equal(pickBingeStream(streams, "vanished").url, "a");
});

test("a source with nothing to play is not a candidate", () => {
  assert.equal(pickBingeStream([{ title: "no url" }], "mine"), null);
  assert.equal(
    pickBingeStream([{ title: "no url" }, { externalUrl: "x" }]).externalUrl,
    "x",
  );
});
