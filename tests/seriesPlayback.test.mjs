import assert from "node:assert/strict";
import test from "node:test";

import { buildWatchIndex } from "../src/lib/progress.ts";
import { seriesPlaybackTarget } from "../src/lib/seriesPlayback.ts";

const videos = [
  { id: "s1e1", season: 1, episode: 1 },
  { id: "s1e2", season: 1, episode: 2 },
  { id: "s2e1", season: 2, episode: 1 },
  { id: "s2e2", season: 2, episode: 2 },
];
const meta = { id: "show", videos };

test("series details use the season containing an unfinished resume", () => {
  const index = buildWatchIndex(
    [{
      contentId: "show", contentType: "series", videoId: "s2e1",
      season: 2, episode: 1, positionMs: 10_000, durationMs: 40_000,
      lastWatched: 100,
    }],
    [],
  );
  const target = seriesPlaybackTarget(meta, index);
  assert.equal(target.video?.id, "s2e1");
  assert.equal(target.kind, "resume");
});

test("series details advance to the next season after a season finale", () => {
  const watched = videos.slice(0, 2).map((video, index) => ({
    contentId: "show", contentType: "series", title: "Show",
    season: video.season, episode: video.episode, watchedAt: index + 1,
  }));
  const target = seriesPlaybackTarget(meta, buildWatchIndex([], watched));
  assert.equal(target.video?.id, "s2e1");
  assert.equal(target.kind, "next");
});
