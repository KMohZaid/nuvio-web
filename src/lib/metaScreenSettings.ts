import type { SettingsBlob } from "./settingsBlob";

export const META_SCREEN_SECTION_KEYS = [
  "ACTIONS",
  "OVERVIEW",
  "EPISODES",
  "PRODUCTION",
  "CAST",
  "COMMENTS",
  "TRAILERS",
  "DETAILS",
  "COLLECTION",
  "MORE_LIKE_THIS",
] as const;

export type MetaScreenSectionKey = (typeof META_SCREEN_SECTION_KEYS)[number];
export type MetaScreenSection = {
  key: MetaScreenSectionKey;
  enabled: boolean;
  order: number;
  tabGroup: number | null;
};
export type MetaScreenSettings = {
  items: MetaScreenSection[];
  backgroundMode: "normal" | "cinematic" | "dominant_color";
  episodeCardStyle: "horizontal" | "list";
  blurUnwatchedEpisodes: boolean;
};

const FEATURE = "meta_screen_settings_payload";
const defaults = META_SCREEN_SECTION_KEYS.map((key, order) => ({
  key,
  enabled: true,
  order,
  tabGroup: null,
}));

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function payloadOf(blob: SettingsBlob | null): Record<string, unknown> {
  const serialized = blob?.features?.[FEATURE];
  if (typeof serialized !== "string") return {};
  try {
    return recordOf(JSON.parse(serialized));
  } catch {
    return {};
  }
}

function writePayload(
  blob: SettingsBlob,
  patch: Record<string, unknown>,
): SettingsBlob {
  const current = payloadOf(blob);
  return {
    ...blob,
    version: typeof blob.version === "number" ? blob.version : 3,
    features: {
      ...blob.features,
      [FEATURE]: JSON.stringify({ ...current, ...patch }),
    },
  };
}

const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

export function readMetaScreenSettings(
  blob: SettingsBlob | null,
): MetaScreenSettings {
  const raw = payloadOf(blob);
  const rows = Array.isArray(raw.items) ? raw.items.map(recordOf) : [];
  const stored = new Map<string, Record<string, unknown>>();
  for (const row of rows)
    if (typeof row.key === "string" && !stored.has(row.key))
      stored.set(row.key, row);

  const items = defaults
    .map((fallback) => {
      const row = stored.get(fallback.key);
      return {
        key: fallback.key,
        enabled: bool(row?.enabled, true),
        order:
          typeof row?.order === "number" && Number.isFinite(row.order)
            ? row.order
            : fallback.order,
        tabGroup:
          typeof row?.tabGroup === "number" && Number.isFinite(row.tabGroup)
            ? Math.max(0, Math.trunc(row.tabGroup))
            : null,
      };
    })
    .sort((left, right) => left.order - right.order);

  const mode = raw.background_mode;
  const backgroundMode =
    mode === "normal" || mode === "cinematic" || mode === "dominant_color"
      ? mode
      : raw.cinematicBackground === true
        ? "cinematic"
        : "dominant_color";
  return {
    items,
    backgroundMode,
    episodeCardStyle: raw.episodeCardStyle === "list" ? "list" : "horizontal",
    blurUnwatchedEpisodes: bool(raw.blur_unwatched_episodes, false),
  };
}

/** Patches top-level supported fields while retaining future Nuvio fields. */
export function withMetaScreenPayload(
  blob: SettingsBlob,
  patch: Record<string, unknown>,
): SettingsBlob {
  return writePayload(blob, patch);
}

/** Changes one section without replacing its unknown fields or hidden rows. */
export function withMetaScreenSection(
  blob: SettingsBlob,
  key: MetaScreenSectionKey,
  patch: Partial<Pick<MetaScreenSection, "enabled" | "order">>,
): SettingsBlob {
  const raw = payloadOf(blob);
  const rows = Array.isArray(raw.items) ? [...raw.items] : [];
  const index = rows.findIndex((value) => recordOf(value).key === key);
  if (index >= 0) rows[index] = { ...recordOf(rows[index]), ...patch, key };
  else {
    const fallback = defaults.find((item) => item.key === key)!;
    rows.push({ ...fallback, ...patch });
  }
  return writePayload(blob, { items: rows });
}

/** Swaps order values between adjacent web-supported sections. */
export function moveMetaScreenSection(
  blob: SettingsBlob,
  key: MetaScreenSectionKey,
  direction: -1 | 1,
  supportedKeys: readonly MetaScreenSectionKey[],
): SettingsBlob {
  const visible = readMetaScreenSettings(blob).items.filter((item) =>
    supportedKeys.includes(item.key),
  );
  const from = visible.findIndex((item) => item.key === key);
  const other = visible[from + direction];
  if (from < 0 || !other) return blob;
  const current = visible[from]!;
  const first = withMetaScreenSection(blob, current.key, {
    order: other.order,
  });
  return withMetaScreenSection(first, other.key, { order: current.order });
}
