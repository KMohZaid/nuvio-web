import assert from "node:assert/strict";
import test from "node:test";

import { buildContinueWatching } from "../src/lib/progress.ts";
import { withBlobStringPayload } from "../src/lib/settingsBlob.ts";

const blobWith = (payload) => ({
  version: 3,
  features: {
    continue_watching_settings_payload: JSON.stringify(payload),
    future_feature: { keep: true },
  },
});

test("Continue Watching writes keep the outer string and unknown fields", () => {
  const before = blobWith({ style: "Card", futureOption: { keep: true } });
  const after = withBlobStringPayload(
    before,
    "continue_watching_settings_payload",
    { style: "Poster" },
  );
  assert.equal(typeof after.features.continue_watching_settings_payload, "string");
  assert.deepEqual(
    JSON.parse(after.features.continue_watching_settings_payload),
    { style: "Poster", futureOption: { keep: true } },
  );
  assert.deepEqual(after.features.future_feature, { keep: true });
});

test("unaired and dismissed Next Up settings affect the generated row", () => {
  const meta = {
    id: "show",
    type: "series",
    name: "Show",
    genres: [],
    cast: [],
    director: [],
    writer: [],
    trailers: [],
    externalRatings: [],
    manifestUrl: "https://example.invalid/manifest.json",
    addonName: "Test",
    videos: [
      { id: "e1", title: "One", season: 1, episode: 1 },
      {
        id: "e2",
        title: "Two",
        season: 1,
        episode: 2,
        released: "2099-01-01T00:00:00.000Z",
      },
    ],
  };
  const watched = [{
    contentId: "show",
    contentType: "series",
    title: "Show",
    season: 1,
    episode: 1,
    watchedAt: 10,
  }];
  const defaults = {
    isVisible: true,
    style: "Card",
    upNextFromFurthestEpisode: true,
    useEpisodeThumbnails: true,
    showUnairedNextUp: true,
    blurNextUp: false,
    dismissedNextUpKeys: [],
    showResumePromptOnLaunch: true,
    sortMode: "DEFAULT",
  };
  assert.equal(buildContinueWatching([], watched, [meta], defaults).length, 1);
  assert.equal(
    buildContinueWatching([], watched, [meta], {
      ...defaults,
      showUnairedNextUp: false,
    }).length,
    0,
  );
  assert.equal(
    buildContinueWatching([], watched, [meta], {
      ...defaults,
      dismissedNextUpKeys: ["show|1|2"],
    }).length,
    0,
  );
});
