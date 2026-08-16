import assert from "node:assert/strict";
import test from "node:test";

import {
  moveMetaScreenSection,
  readMetaScreenSettings,
  withMetaScreenPayload,
  withMetaScreenSection,
} from "../src/lib/metaScreenSettings.ts";

const payload = (value) => ({
  version: 3,
  futureTopLevel: "keep",
  features: {
    meta_screen_settings_payload: JSON.stringify(value),
    future_feature: { keep: true },
  },
});

const decoded = (blob) =>
  JSON.parse(blob.features.meta_screen_settings_payload);

test("meta-screen reads Nuvio's exact supported payload keys", () => {
  const settings = readMetaScreenSettings(
    payload({
      background_mode: "cinematic",
      episodeCardStyle: "list",
      blur_unwatched_episodes: true,
      items: [{ key: "CAST", enabled: false, order: 1, tabGroup: 2 }],
    }),
  );
  assert.equal(settings.backgroundMode, "cinematic");
  assert.equal(settings.episodeCardStyle, "list");
  assert.equal(settings.blurUnwatchedEpisodes, true);
  assert.deepEqual(
    settings.items.find((item) => item.key === "CAST"),
    { key: "CAST", enabled: false, order: 1, tabGroup: 2 },
  );
});

test("meta-screen writes preserve unknown payload, row, and blob fields", () => {
  const before = payload({
    futureOption: { keep: true },
    items: [
      {
        key: "PRODUCTION",
        enabled: true,
        order: 3,
        tabGroup: null,
        futureRowOption: 42,
      },
      { key: "FUTURE_SECTION", enabled: true, order: 50, data: "keep" },
    ],
  });
  const withBackground = withMetaScreenPayload(before, {
    background_mode: "normal",
  });
  const after = withMetaScreenSection(withBackground, "PRODUCTION", {
    enabled: false,
  });
  const result = decoded(after);
  assert.equal(after.futureTopLevel, "keep");
  assert.deepEqual(after.features.future_feature, { keep: true });
  assert.deepEqual(result.futureOption, { keep: true });
  assert.equal(result.background_mode, "normal");
  assert.deepEqual(result.items[0], {
    key: "PRODUCTION",
    enabled: false,
    order: 3,
    tabGroup: null,
    futureRowOption: 42,
  });
  assert.deepEqual(result.items[1], {
    key: "FUTURE_SECTION",
    enabled: true,
    order: 50,
    data: "keep",
  });
});

test("moving a web detail section swaps only supported order values", () => {
  const before = payload({
    items: [
      { key: "OVERVIEW", enabled: true, order: 1, keep: "hidden" },
      { key: "EPISODES", enabled: true, order: 2 },
      { key: "PRODUCTION", enabled: true, order: 3, keep: "production" },
      { key: "CAST", enabled: true, order: 4, keep: "cast" },
    ],
  });
  const after = moveMetaScreenSection(
    before,
    "CAST",
    -1,
    ["EPISODES", "PRODUCTION", "CAST", "TRAILERS", "DETAILS"],
  );
  const rows = decoded(after).items;
  assert.equal(rows.find((row) => row.key === "CAST").order, 3);
  assert.equal(rows.find((row) => row.key === "PRODUCTION").order, 4);
  assert.deepEqual(rows.find((row) => row.key === "OVERVIEW"), {
    key: "OVERVIEW",
    enabled: true,
    order: 1,
    keep: "hidden",
  });
  assert.equal(rows.find((row) => row.key === "CAST").keep, "cast");
});
