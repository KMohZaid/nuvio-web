import assert from "node:assert/strict";
import test from "node:test";

import {
  blobStringPayload,
  blobTypedValue,
  withBlobRawValue,
  withBlobStringPayload,
  withBlobTypedValue,
} from "../src/lib/settingsBlob.ts";

const fixture = () => ({
  version: 3,
  futureTopLevel: { keep: true },
  features: {
    theme_settings: {
      amoled_enabled: { type: "boolean", value: true },
      future_theme_key: { type: "string", value: "untouched" },
    },
    poster_card_style_settings_payload: JSON.stringify({
      widthDp: 140,
      futurePosterKey: 42,
    }),
    notifications_settings: {
      episode_release_alerts_enabled: false,
      futureNotificationKey: "untouched",
    },
    future_feature: [1, 2, 3],
  },
});

test("typed preferences validate both wrapper type and runtime value", () => {
  const blob = fixture();
  assert.equal(
    blobTypedValue(blob, "theme_settings", "amoled_enabled", "boolean", false),
    true,
  );
  assert.equal(
    blobTypedValue(blob, "theme_settings", "amoled_enabled", "string", "fallback"),
    "fallback",
  );
});

test("typed writes preserve all unknown blob and feature fields", () => {
  const next = withBlobTypedValue(
    fixture(),
    "theme_settings",
    "amoled_enabled",
    "boolean",
    false,
  );
  assert.deepEqual(next.futureTopLevel, { keep: true });
  assert.deepEqual(next.features.future_feature, [1, 2, 3]);
  assert.deepEqual(next.features.theme_settings.future_theme_key, {
    type: "string",
    value: "untouched",
  });
});

test("JSON-string payload writes remain strings and preserve future keys", () => {
  const next = withBlobStringPayload(
    fixture(),
    "poster_card_style_settings_payload",
    { cornerRadiusDp: 18 },
  );
  assert.equal(
    typeof next.features.poster_card_style_settings_payload,
    "string",
  );
  assert.deepEqual(
    blobStringPayload(next, "poster_card_style_settings_payload", {}),
    { widthDp: 140, futurePosterKey: 42, cornerRadiusDp: 18 },
  );
});

test("raw payload writes do not turn notification values into typed wrappers", () => {
  const next = withBlobRawValue(
    fixture(),
    "notifications_settings",
    "episode_release_alerts_enabled",
    true,
  );
  assert.equal(
    next.features.notifications_settings.episode_release_alerts_enabled,
    true,
  );
  assert.equal(
    next.features.notifications_settings.futureNotificationKey,
    "untouched",
  );
});
