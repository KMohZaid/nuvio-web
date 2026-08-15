import type {
  AddonRow,
  AvatarCatalogItem,
  BackendConfig,
  LibraryItem,
  Meta,
  Profile,
  ProgressRow,
  Session,
  WatchedItem,
} from "../types";
import { deleteValue, getValue, setValue } from "./idb";

const CONFIG_KEY = "backend-config";
const REFRESH_KEY = "refresh-session";
const CLIENT_ID = `nuvio-web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
let activeSession: Session | null = null;

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  user?: { id: string; email?: string };
};

export function officialBackend(): BackendConfig | null {
  const url = import.meta.env.VITE_NUVIO_SUPABASE_URL?.trim().replace(
    /\/+$/,
    "",
  );
  const key = import.meta.env.VITE_NUVIO_SUPABASE_ANON_KEY?.trim();
  return url && key ? { url, key, selfHosted: false } : null;
}

export function normalizeBackend(
  url: string,
  key: string,
  selfHosted = true,
): BackendConfig {
  const parsed = new URL(url.trim());
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Enter a plain HTTP(S) backend URL without credentials, query, or fragment.",
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  ) {
    throw new Error("Remote self-hosted backends must use HTTPS.");
  }
  const cleanKey = key.trim();
  if (!cleanKey || cleanKey.includes("\n") || cleanKey.includes("\r"))
    throw new Error("Enter a valid publishable key.");
  return {
    url: parsed.toString().replace(/\/+$/, ""),
    key: cleanKey,
    selfHosted,
  };
}

async function request<T>(
  backend: BackendConfig,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${backend.url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: backend.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Backend request failed (${response.status})`;
      try {
        message = JSON.parse(text).msg || JSON.parse(text).message || message;
      } catch {
        if (text.trim()) message = text.slice(0, 240);
      }
      throw new Error(message);
    }
    return (text ? JSON.parse(text) : null) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function installToken(
  backend: BackendConfig,
  payload: TokenPayload,
): Promise<Session> {
  if (!payload.access_token || !payload.refresh_token || !payload.user?.id)
    throw new Error("The backend did not return a usable session.");
  activeSession = {
    accessToken: payload.access_token,
    user: payload.user,
    backend,
  };
  await Promise.all([
    setValue(CONFIG_KEY, backend),
    setValue(REFRESH_KEY, {
      backendUrl: backend.url,
      refreshToken: payload.refresh_token,
    }),
  ]);
  return activeSession;
}

export async function signIn(
  backend: BackendConfig,
  email: string,
  password: string,
): Promise<Session> {
  const payload = await request<TokenPayload>(
    backend,
    "/auth/v1/token?grant_type=password",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
    },
  );
  return installToken(backend, payload);
}

export async function signUp(
  backend: BackendConfig,
  email: string,
  password: string,
): Promise<Session | null> {
  const payload = await request<TokenPayload>(backend, "/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return payload.access_token ? installToken(backend, payload) : null;
}

export async function restoreSession(): Promise<Session | null> {
  const [savedBackend, savedRefresh] = await Promise.all([
    getValue<BackendConfig>(CONFIG_KEY),
    getValue<{ backendUrl: string; refreshToken: string }>(REFRESH_KEY),
  ]);
  const backend = savedBackend ?? officialBackend();
  if (!backend || !savedRefresh || savedRefresh.backendUrl !== backend.url)
    return null;
  try {
    const payload = await request<TokenPayload>(
      backend,
      "/auth/v1/token?grant_type=refresh_token",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: savedRefresh.refreshToken }),
      },
    );
    return installToken(backend, payload);
  } catch {
    await deleteValue(REFRESH_KEY);
    return null;
  }
}

export async function signOut(): Promise<void> {
  if (activeSession) {
    request(
      activeSession.backend,
      "/auth/v1/logout",
      { method: "POST" },
      activeSession.accessToken,
    ).catch(() => undefined);
  }
  activeSession = null;
  await deleteValue(REFRESH_KEY);
}

async function authorized<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!activeSession) throw new Error("Sign in first.");
  return request<T>(
    activeSession.backend,
    path,
    init,
    activeSession.accessToken,
  );
}

export async function rpc<T>(name: string, body: unknown): Promise<T> {
  return authorized<T>(`/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function camelProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id ?? ""),
    userId: String(row.user_id ?? row.userId ?? ""),
    profileIndex: Number(row.profile_index ?? row.profileIndex ?? 1),
    name: String(row.name ?? "Profile"),
    avatarColorHex: String(
      row.avatar_color_hex ?? row.avatarColorHex ?? "#397a63",
    ),
    avatarId: row.avatar_id ? String(row.avatar_id) : undefined,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
  };
}

export async function loadProfiles(): Promise<Profile[]> {
  const rows = await rpc<Array<Record<string, unknown>>>(
    "sync_pull_profiles",
    {},
  );
  return rows.map(camelProfile).sort((a, b) => a.profileIndex - b.profileIndex);
}

export async function loadAvatarCatalog(): Promise<AvatarCatalogItem[]> {
  if (!activeSession) throw new Error("Sign in first.");
  const rows = await rpc<Array<Record<string, unknown>>>(
    "get_avatar_catalog",
    {},
  );
  const base = activeSession.backend.url.replace(/\/+$/, "");
  return rows
    .filter((row) => row.is_active !== false)
    .map((row) => {
      const storagePath = String(row.storage_path ?? "").replace(/^\/+/, "");
      return {
        id: String(row.id ?? ""),
        displayName: String(row.display_name ?? "Avatar"),
        category: String(row.category ?? ""),
        sortOrder: Number(row.sort_order ?? 0),
        backgroundColor: row.bg_color ? String(row.bg_color) : undefined,
        imageUrl: row.image_url
          ? String(row.image_url)
          : storagePath
            ? `${base}/storage/v1/object/public/avatars/${storagePath}`
            : "",
      };
    })
    .filter((item) => item.id && item.imageUrl)
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.sortOrder - right.sortOrder,
    );
}

export async function loadAddons(profileIndex: number): Promise<AddonRow[]> {
  const query = new URLSearchParams({
    profile_id: `eq.${profileIndex}`,
    select: "url,name,enabled,sort_order",
    order: "sort_order.asc",
  });
  const rows = await authorized<Array<Record<string, unknown>>>(
    `/rest/v1/addons?${query}`,
  );
  return rows.map((row) => ({
    url: String(row.url ?? ""),
    name: row.name ? String(row.name) : undefined,
    enabled: row.enabled !== false,
    sortOrder: Number(row.sort_order ?? 0),
  }));
}

export async function saveAddons(
  profileIndex: number,
  addons: AddonRow[],
): Promise<void> {
  await rpc("sync_push_addons", {
    p_profile_id: profileIndex,
    p_addons: addons.map((addon, index) => ({
      url: addon.url,
      name: addon.name ?? "",
      enabled: addon.enabled,
      sort_order: index,
    })),
    p_origin_client_id: CLIENT_ID,
  });
}

function libraryMeta(row: Record<string, unknown>): LibraryItem {
  const manifest = String(row.addon_base_url ?? "");
  return {
    id: String(row.content_id ?? ""),
    type: String(row.content_type ?? "movie"),
    name: String(row.name ?? "Untitled"),
    poster: row.poster ? String(row.poster) : undefined,
    background: row.background ? String(row.background) : undefined,
    description: row.description ? String(row.description) : undefined,
    releaseInfo: row.release_info ? String(row.release_info) : undefined,
    imdbRating: row.imdb_rating != null ? String(row.imdb_rating) : undefined,
    genres: Array.isArray(row.genres) ? row.genres.map(String) : [],
    cast: [],
    director: [],
    writer: [],
    trailers: [],
    externalRatings: [],
    videos: [],
    manifestUrl:
      !manifest || manifest.includes("manifest.json")
        ? manifest
        : `${manifest.replace(/\/+$/, "")}/manifest.json`,
    addonName: "",
    addedAt: Number(row.added_at ?? 0),
  };
}

export async function loadLibrary(
  profileIndex: number,
): Promise<LibraryItem[]> {
  const result: LibraryItem[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const rows = await rpc<Array<Record<string, unknown>>>(
      "sync_pull_library",
      { p_profile_id: profileIndex, p_limit: 200, p_offset: offset },
    );
    result.push(...rows.map(libraryMeta));
    if (rows.length < 200) break;
  }
  return result;
}

export async function loadProgress(
  profileIndex: number,
): Promise<ProgressRow[]> {
  const rows = await rpc<Array<Record<string, unknown>>>(
    "sync_pull_watch_progress",
    { p_profile_id: profileIndex, p_limit: 1000 },
  );
  return rows.map((row) => ({
    contentId: String(row.content_id ?? ""),
    contentType: String(row.content_type ?? ""),
    videoId: String(row.video_id ?? ""),
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    positionMs: Number(row.position ?? row.position_ms ?? 0),
    durationMs: Number(row.duration ?? row.duration_ms ?? 0),
    lastWatched: Number(row.last_watched ?? 0),
    progressKey: row.progress_key ? String(row.progress_key) : undefined,
  }));
}

export async function loadWatchedItems(
  profileIndex: number,
): Promise<WatchedItem[]> {
  const result: WatchedItem[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const rows = await rpc<Array<Record<string, unknown>>>(
      "sync_pull_watched_items",
      { p_profile_id: profileIndex, p_page: page, p_page_size: 200 },
    );
    result.push(
      ...rows
        .map((row) => ({
          contentId: String(row.content_id ?? ""),
          contentType: String(row.content_type ?? ""),
          title: String(row.title ?? ""),
          season: row.season == null ? undefined : Number(row.season),
          episode: row.episode == null ? undefined : Number(row.episode),
          watchedAt: Number(row.watched_at ?? 0),
        }))
        .filter((row) => row.contentId),
    );
    if (rows.length < 200) break;
  }
  return result;
}

/**
 * Nuvio stores settings per platform, one row each for `desktop` and
 * `mobile`. The web client has no row of its own, so it joins whichever one
 * matches the device it is running on: installed on a phone it shares the
 * mobile app's settings, on a desktop browser the desktop client's.
 */
export function settingsPlatform(): "desktop" | "mobile" {
  const coarse = matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? "mobile"
    : "desktop";
}

export type SettingsBlob = {
  version: number;
  features: Record<string, Record<string, { type: string; value: unknown }>>;
};

const emptyBlob = (): SettingsBlob => ({ version: 3, features: {} });

export async function loadSettingsBlob(
  profileIndex: number,
): Promise<SettingsBlob> {
  const rows = await rpc<Array<Record<string, unknown>>>(
    "sync_pull_profile_settings_blob",
    { p_profile_id: profileIndex, p_platform: settingsPlatform() },
  );
  const value = rows?.[0]?.settings_json;
  return value && typeof value === "object"
    ? (value as SettingsBlob)
    : emptyBlob();
}

/** Reads one typed boolean out of the blob, matching Nuvio's storage shape. */
export function blobBoolean(
  blob: SettingsBlob | null,
  feature: string,
  key: string,
  fallback: boolean,
): boolean {
  const entry = blob?.features?.[feature]?.[key];
  return entry?.type === "boolean" && typeof entry.value === "boolean"
    ? entry.value
    : fallback;
}

/**
 * Writes one typed boolean and pushes the whole blob back.
 *
 * The push replaces the row wholesale, so the existing blob has to be read,
 * merged into, and returned intact — sending only the changed key would drop
 * every other setting on that platform.
 */
export async function pushBlobBoolean(
  profileIndex: number,
  blob: SettingsBlob,
  feature: string,
  key: string,
  value: boolean,
): Promise<SettingsBlob> {
  const next: SettingsBlob = {
    version: blob.version ?? 3,
    features: {
      ...blob.features,
      [feature]: {
        ...(blob.features?.[feature] ?? {}),
        [key]: { type: "boolean", value },
      },
    },
  };
  await rpc("sync_push_profile_settings_blob", {
    p_profile_id: profileIndex,
    p_platform: settingsPlatform(),
    p_settings_json: next,
    p_origin_client_id: CLIENT_ID,
  });
  return next;
}

/** Identifies one watchable thing: a movie, or one episode of a series. */
export type WatchIdentity = {
  contentId: string;
  contentType: string;
  season?: number;
  episode?: number;
};

/**
 * Nuvio's key for a resume point. A half-identified episode falls back to the
 * bare content id, matching buildWatchProgressKey on the other clients — get
 * this wrong and the row is orphaned rather than replaced.
 */
function buildProgressKey(identity: WatchIdentity): string {
  return identity.season != null && identity.episode != null
    ? `${identity.contentId}_s${identity.season}e${identity.episode}`
    : identity.contentId;
}

/**
 * The server's stored key is opaque and may have come from another client, so
 * an existing row's key always wins over a recomputed one. Recomputing would
 * insert a duplicate instead of replacing the row.
 */
function resolveProgressKey(
  rows: ProgressRow[],
  identity: WatchIdentity,
): string {
  const logical = rows.filter(
    (row) =>
      row.contentId === identity.contentId &&
      row.season === identity.season &&
      row.episode === identity.episode,
  );
  const freshest = [...logical].sort((a, b) => b.lastWatched - a.lastWatched)[0];
  return freshest?.progressKey?.trim() || buildProgressKey(identity);
}

/**
 * Marks or clears one title/episode as watched, and drops any resume point for
 * it so the two can never disagree. Mirrors the desktop client's payloads
 * exactly; `progressRows` is the current snapshot, used only to recover the
 * server's own progress key.
 */
export async function setWatched(
  profileIndex: number,
  identity: WatchIdentity,
  title: string,
  watched: boolean,
  progressRows: ProgressRow[],
): Promise<void> {
  if (watched) {
    await rpc("sync_push_watched_items", {
      p_profile_id: profileIndex,
      p_items: [
        {
          content_id: identity.contentId,
          content_type: identity.contentType,
          title,
          season: identity.season ?? null,
          episode: identity.episode ?? null,
          watched_at: Date.now(),
        },
      ],
      p_origin_client_id: CLIENT_ID,
    });
  } else {
    await rpc("sync_delete_watched_items", {
      p_profile_id: profileIndex,
      p_keys: [
        {
          content_id: identity.contentId,
          season: identity.season ?? null,
          episode: identity.episode ?? null,
        },
      ],
      p_origin_client_id: CLIENT_ID,
    });
  }
  // A stale resume point would still draw a progress bar under a row the user
  // just toggled, so clear it in both directions.
  await rpc("sync_delete_watch_progress", {
    p_profile_id: profileIndex,
    p_keys: [resolveProgressKey(progressRows, identity)],
    p_origin_client_id: CLIENT_ID,
  });
}

export function currentSession(): Session | null {
  return activeSession;
}
