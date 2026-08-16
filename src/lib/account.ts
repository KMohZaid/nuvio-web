import type {
  Collection,
  CollectionFolder,
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
import {
  blobRawValue,
  blobStringPayload,
  blobTypedValue,
  emptySettingsBlob,
  withBlobRawValue,
  withBlobStringPayload,
  withBlobTypedValue,
  type SettingsBlob,
  type SyncPreferenceType,
  type SyncPreferenceValue,
} from "./settingsBlob";
import {
  decodeProviderCredentials,
  providerCredentialPayload,
  withProviderCredential,
  type ProviderCredentialRow,
} from "./providerCredentials";

export type { ProviderCredentialRow };

export {
  blobStringPayload,
  blobTypedValue,
  withBlobRawValue,
  withBlobStringPayload,
  withBlobTypedValue,
};
export type { SettingsBlob, SyncPreferenceType, SyncPreferenceValue };

const CONFIG_KEY = "backend-config";
const REFRESH_KEY = "refresh-session";
const AUTH_LOCK_KEY = "nuvio-web-auth-session";
const AUTH_CHANNEL_NAME = "nuvio-web-auth-session-v1";
const CLIENT_ID = `nuvio-web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const TAB_ID = `tab-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
let activeSession: Session | null = null;
let sessionGeneration = 0;
let sessionAbortController = new AbortController();
let refreshFlight: { generation: number; promise: Promise<string> } | null =
  null;

type StoredRefreshSession = {
  backendUrl: string;
  refreshToken: string;
  /** Shared only within this origin so another tab can reuse a rotation. */
  accessToken?: string;
  userId?: string;
  email?: string;
  updatedAt?: number;
};

type AuthChannelMessage =
  | { source: string; type: "invalidate" }
  | {
      source: string;
      type: "token";
      backendUrl: string;
      accessToken: string;
      userId: string;
      email?: string;
    };
type AuthChannelPayload =
  | { type: "invalidate" }
  | {
      type: "token";
      backendUrl: string;
      accessToken: string;
      userId: string;
      email?: string;
    };

class BackendRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BackendRequestError";
  }
}

class StaleSessionError extends Error {
  constructor() {
    super("The Nuvio session changed while this request was running.");
    this.name = "StaleSessionError";
  }
}

class InvalidSessionPayloadError extends Error {
  constructor(message = "The backend did not return a usable session.") {
    super(message);
    this.name = "InvalidSessionPayloadError";
  }
}

const authChannel =
  typeof globalThis.BroadcastChannel === "function"
    ? new BroadcastChannel(AUTH_CHANNEL_NAME)
    : null;

function broadcastAuth(message: AuthChannelPayload): void {
  authChannel?.postMessage({ ...message, source: TAB_ID });
}

function invalidateLocalSession(): number {
  sessionAbortController.abort();
  sessionAbortController = new AbortController();
  sessionGeneration += 1;
  activeSession = null;
  refreshFlight = null;
  return sessionGeneration;
}

function invalidateSessionAcrossTabs(): number {
  const generation = invalidateLocalSession();
  broadcastAuth({ type: "invalidate" });
  return generation;
}

function assertCurrentGeneration(generation: number): void {
  if (generation !== sessionGeneration) throw new StaleSessionError();
}

authChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as Partial<AuthChannelMessage> | null;
  if (!message || message.source === TAB_ID) return;
  if (message.type === "invalidate") {
    invalidateLocalSession();
    return;
  }
  if (
    message.type === "token" &&
    activeSession &&
    message.backendUrl === activeSession.backend.url &&
    message.userId === activeSession.user.id &&
    typeof message.accessToken === "string" &&
    message.accessToken
  ) {
    activeSession = {
      ...activeSession,
      accessToken: message.accessToken,
      user: {
        ...activeSession.user,
        email: message.email ?? activeSession.user.email,
      },
    };
  }
});

async function withAuthLock<T>(work: () => Promise<T>): Promise<T> {
  // Web Locks are origin-wide rather than tab-local, so refresh-token rotation,
  // sign-out, and backend changes cannot interleave. Current Chromium, Firefox,
  // and Safari/iOS releases implement this. The fallback still keeps the
  // in-tab promise single-flight on older embedded browsers.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(AUTH_LOCK_KEY, { mode: "exclusive" }, work);
  }
  return work();
}

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
  const abortFromCaller = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
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
      throw new BackendRequestError(message, response.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function sessionFromToken(
  backend: BackendConfig,
  payload: TokenPayload,
): Session {
  if (!payload.access_token || !payload.refresh_token || !payload.user?.id)
    throw new InvalidSessionPayloadError();
  return {
    accessToken: payload.access_token,
    user: payload.user,
    backend,
  };
}

async function installToken(
  backend: BackendConfig,
  payload: TokenPayload,
  generation: number,
): Promise<Session> {
  const session = sessionFromToken(backend, payload);
  return withAuthLock(async () => {
    assertCurrentGeneration(generation);
    // The refresh credential is durable before the access token is visible to
    // callers. A failed IndexedDB write therefore cannot create a session that
    // silently dies on reload.
    await Promise.all([
      setValue(CONFIG_KEY, backend),
      setValue<StoredRefreshSession>(REFRESH_KEY, {
        backendUrl: backend.url,
        refreshToken: payload.refresh_token!,
        accessToken: session.accessToken,
        userId: session.user.id,
        email: session.user.email,
        updatedAt: Date.now(),
      }),
    ]);
    assertCurrentGeneration(generation);
    activeSession = session;
    broadcastAuth({
      type: "token",
      backendUrl: backend.url,
      accessToken: session.accessToken,
      userId: session.user.id,
      email: session.user.email,
    });
    return session;
  });
}

export async function signIn(
  backend: BackendConfig,
  email: string,
  password: string,
): Promise<Session> {
  // Changing account or backend invalidates every pending request before the
  // new password exchange starts. A slow response from the old session can no
  // longer publish state after this transition.
  const generation = invalidateSessionAcrossTabs();
  const signal = sessionAbortController.signal;
  const payload = await request<TokenPayload>(
    backend,
    "/auth/v1/token?grant_type=password",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      signal,
    },
  );
  return installToken(backend, payload, generation);
}

export async function restoreSession(): Promise<Session | null> {
  const generation = invalidateLocalSession();
  const signal = sessionAbortController.signal;
  try {
    return await withAuthLock(async () => {
      assertCurrentGeneration(generation);
      const [savedBackend, savedRefresh] = await Promise.all([
        getValue<BackendConfig>(CONFIG_KEY),
        getValue<StoredRefreshSession>(REFRESH_KEY),
      ]);
      const backend = savedBackend ?? officialBackend();
      if (
        !backend ||
        !savedRefresh ||
        savedRefresh.backendUrl !== backend.url
      )
        return null;
      const payload = await request<TokenPayload>(
        backend,
        "/auth/v1/token?grant_type=refresh_token",
        {
          method: "POST",
          body: JSON.stringify({
            refresh_token: savedRefresh.refreshToken,
          }),
          signal,
        },
      );
      assertCurrentGeneration(generation);
      const session = sessionFromToken(backend, payload);
      await setValue<StoredRefreshSession>(REFRESH_KEY, {
        backendUrl: backend.url,
        refreshToken: payload.refresh_token!,
        accessToken: payload.access_token!,
        userId: payload.user!.id,
        email: payload.user!.email,
        updatedAt: Date.now(),
      });
      assertCurrentGeneration(generation);
      activeSession = session;
      broadcastAuth({
        type: "token",
        backendUrl: backend.url,
        accessToken: session.accessToken,
        userId: session.user.id,
        email: session.user.email,
      });
      return session;
    });
  } catch (error) {
    // Invalid refresh credentials are terminal. Network/timeout failures are
    // not: retain the backend-scoped token so a reload can try again.
    const terminal =
      (error instanceof BackendRequestError &&
        [400, 401, 403].includes(error.status)) ||
      error instanceof InvalidSessionPayloadError;
    if (generation === sessionGeneration && terminal) {
      invalidateSessionAcrossTabs();
      await withAuthLock(async () => {
        await deleteValue(REFRESH_KEY);
      });
    }
    return null;
  }
}

export async function signOut(): Promise<void> {
  const session = activeSession;
  invalidateSessionAcrossTabs();
  if (session) {
    request(
      session.backend,
      "/auth/v1/logout",
      { method: "POST" },
      session.accessToken,
    ).catch(() => undefined);
  }
  await withAuthLock(() => deleteValue(REFRESH_KEY));
}

function isRefreshableUnauthorized(error: unknown): boolean {
  return error instanceof BackendRequestError && error.status === 401;
}

async function refreshAccessToken(
  session: Session,
  generation: number,
  rejectedAccessToken: string,
  signal: AbortSignal,
): Promise<string> {
  assertCurrentGeneration(generation);
  if (refreshFlight?.generation === generation) return refreshFlight.promise;

  const run = withAuthLock(async () => {
    assertCurrentGeneration(generation);
    const saved = await getValue<StoredRefreshSession>(REFRESH_KEY);
    if (
      !saved ||
      saved.backendUrl !== session.backend.url ||
      !saved.refreshToken.trim()
    ) {
      invalidateSessionAcrossTabs();
      throw new Error("The saved Nuvio session has expired. Sign in again.");
    }

    // A different tab may have rotated the token while this tab waited for the
    // origin-wide lock. Its persisted access token is authoritative for the
    // same backend/user and avoids a second refresh request.
    if (
      saved.accessToken &&
      saved.accessToken !== rejectedAccessToken &&
      saved.userId === session.user.id
    ) {
      assertCurrentGeneration(generation);
      activeSession = { ...session, accessToken: saved.accessToken };
      return saved.accessToken;
    }

    let payload: TokenPayload;
    try {
      payload = await request<TokenPayload>(
        session.backend,
        "/auth/v1/token?grant_type=refresh_token",
        {
          method: "POST",
          body: JSON.stringify({ refresh_token: saved.refreshToken }),
          signal,
        },
      );
    } catch (error) {
      if (
        error instanceof BackendRequestError &&
        [400, 401, 403].includes(error.status)
      ) {
        invalidateSessionAcrossTabs();
        await deleteValue(REFRESH_KEY);
      }
      throw error;
    }

    const accessToken = payload.access_token?.trim();
    const refreshToken = payload.refresh_token?.trim();
    if (!accessToken || !refreshToken) {
      invalidateSessionAcrossTabs();
      await deleteValue(REFRESH_KEY);
      throw new InvalidSessionPayloadError(
        "The backend did not return a refreshed Nuvio session.",
      );
    }
    assertCurrentGeneration(generation);
    await setValue<StoredRefreshSession>(REFRESH_KEY, {
      backendUrl: session.backend.url,
      refreshToken,
      accessToken,
      userId: session.user.id,
      email: payload.user?.email ?? session.user.email,
      updatedAt: Date.now(),
    });
    // Persist the rotated refresh token before publishing the access token.
    assertCurrentGeneration(generation);
    activeSession = {
      ...session,
      accessToken,
      user: {
        ...session.user,
        email: payload.user?.email ?? session.user.email,
      },
    };
    broadcastAuth({
      type: "token",
      backendUrl: session.backend.url,
      accessToken,
      userId: session.user.id,
      email: activeSession.user.email,
    });
    return accessToken;
  });
  const tracked = run.finally(() => {
    if (refreshFlight?.promise === tracked) refreshFlight = null;
  });
  refreshFlight = { generation, promise: tracked };
  return tracked;
}

async function authorized<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = activeSession;
  if (!session) throw new Error("Sign in first.");
  const generation = sessionGeneration;
  const signal = sessionAbortController.signal;
  try {
    const value = await request<T>(
      session.backend,
      path,
      { ...init, signal },
      session.accessToken,
    );
    assertCurrentGeneration(generation);
    return value;
  } catch (error) {
    if (!isRefreshableUnauthorized(error)) throw error;
    assertCurrentGeneration(generation);
    const accessToken = await refreshAccessToken(
      session,
      generation,
      session.accessToken,
      signal,
    );
    // Exactly one replay: a second 401 is returned to the caller and never
    // recursively enters refreshAccessToken.
    const value = await request<T>(
      session.backend,
      path,
      { ...init, signal },
      accessToken,
    );
    assertCurrentGeneration(generation);
    return value;
  }
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

export async function loadSettingsBlob(
  profileIndex: number,
): Promise<SettingsBlob> {
  const rows = await rpc<Array<Record<string, unknown>>>(
    "sync_pull_profile_settings_blob",
    { p_profile_id: profileIndex, p_platform: settingsPlatform() },
  );
  const value = rows?.[0]?.settings_json;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SettingsBlob)
    : emptySettingsBlob();
}

/** The RPC replaces the platform row wholesale, so callers always send all of it. */
export async function pushSettingsBlob(
  profileIndex: number,
  next: SettingsBlob,
): Promise<SettingsBlob> {
  await rpc("sync_push_profile_settings_blob", {
    p_profile_id: profileIndex,
    p_platform: settingsPlatform(),
    p_settings_json: next,
    p_origin_client_id: CLIENT_ID,
  });
  return next;
}

export async function loadProviderCredentials(
  profileIndex: number,
): Promise<ProviderCredentialRow[]> {
  // Match the official client: create any provider rows that do not exist yet
  // before pulling the authoritative remote snapshot. The seed RPC only fills
  // missing rows, so existing/unknown credentials are never overwritten.
  const seedRows: ProviderCredentialRow[] = [
    { provider: "tmdb", credentialJson: { api_key: "" } },
    { provider: "mdblist", credentialJson: { api_key: "" } },
    { provider: "animeskip", credentialJson: { client_id: "" } },
    { provider: "introdb", credentialJson: { api_key: "" } },
  ];
  await rpc("sync_seed_provider_credentials", {
    p_profile_id: profileIndex,
    p_credentials: providerCredentialPayload(seedRows),
    p_origin_client_id: CLIENT_ID,
  });
  return decodeProviderCredentials(
    await rpc<unknown>("sync_pull_provider_credentials", {
      p_profile_id: profileIndex,
    }),
  );
}

/**
 * Credential pushes replace the provider array wholesale. Pull immediately
 * before the merge so a browser tab cannot erase a credential changed by a
 * different Nuvio client since startup.
 */
export async function updateProviderCredential(
  profileIndex: number,
  provider: "tmdb" | "mdblist" | "animeskip" | "introdb",
  value: string,
): Promise<ProviderCredentialRow[]> {
  const field = provider === "animeskip" ? "client_id" : "api_key";
  const current = await loadProviderCredentials(profileIndex);
  const next = withProviderCredential(current, provider, field, value);
  await rpc("sync_push_provider_credentials", {
    p_profile_id: profileIndex,
    p_credentials: providerCredentialPayload(next),
    p_origin_client_id: CLIENT_ID,
  });
  return next;
}

/** Reads one typed boolean out of the blob, matching Nuvio's storage shape. */
export function blobBoolean(
  blob: SettingsBlob | null,
  feature: string,
  key: string,
  fallback: boolean,
): boolean {
  return blobTypedValue(blob, feature, key, "boolean", fallback);
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
  return pushSettingsBlob(
    profileIndex,
    withBlobTypedValue(blob, feature, key, "boolean", value),
  );
}

/**
 * Episode release alerts are stored as a **raw** boolean, not the typed
 * `{type,value}` wrapper every other setting uses — Nuvio decodes
 * `notifications_settings` into a plain payload struct. Writing it typed would
 * make the other clients read it as false.
 */
export function blobRawBoolean(
  blob: SettingsBlob | null,
  feature: string,
  key: string,
  fallback: boolean,
): boolean {
  return blobRawValue(
    blob,
    feature,
    key,
    (value): value is boolean => typeof value === "boolean",
    fallback,
  );
}

export async function pushBlobRawBoolean(
  profileIndex: number,
  blob: SettingsBlob,
  feature: string,
  key: string,
  value: boolean,
): Promise<SettingsBlob> {
  return pushSettingsBlob(
    profileIndex,
    withBlobRawValue(blob, feature, key, value),
  );
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

/**
 * Adds one title to the synced library.
 *
 * Field-for-field with the desktop client's `library::add`. Two details are
 * easy to get wrong and both would write a row Nuvio reads back badly:
 * `imdb_rating` is stored as a **number**, not the display string, and
 * `poster_shape` is upper-cased with "POSTER" as the default.
 */
export async function addToLibrary(
  profileIndex: number,
  item: Meta,
): Promise<void> {
  const rating = Number.parseFloat(item.imdbRating ?? "");
  await rpc("sync_push_library_items", {
    p_profile_id: profileIndex,
    p_items: [
      {
        content_id: item.id,
        content_type: item.type,
        name: item.name,
        poster: item.poster ?? null,
        poster_shape: (item.posterShape ?? "POSTER").toUpperCase(),
        // Nuvio falls back to the banner when there is no backdrop.
        background: item.background ?? item.banner ?? null,
        description: item.description ?? null,
        release_info: item.releaseInfo ?? null,
        imdb_rating: Number.isFinite(rating) ? rating : null,
        genres: item.genres ?? [],
        addon_base_url: item.manifestUrl ?? "",
        added_at: Date.now(),
      },
    ],
    p_origin_client_id: CLIENT_ID,
  });
}

export async function removeFromLibrary(
  profileIndex: number,
  contentId: string,
  contentType: string,
): Promise<void> {
  await rpc("sync_delete_library_items", {
    p_profile_id: profileIndex,
    p_keys: [{ content_id: contentId, content_type: contentType }],
    p_origin_client_id: CLIENT_ID,
  });
}

/** Below this, a resume point is noise rather than a position worth keeping. */
const PROGRESS_STORE_THRESHOLD_MS = 1000;
const COMPLETION_THRESHOLD_FRACTION = 0.9;

export const isComplete = (
  positionMs: number,
  durationMs: number,
  ended: boolean,
) =>
  ended ||
  (durationMs > 0 && positionMs / durationMs >= COMPLETION_THRESHOLD_FRACTION);

/**
 * Stores a resume point, mirroring the desktop client's `progress::push`.
 *
 * A finished row is pinned to the full duration rather than left at 9x%.
 * Without that the other clients keep the title in Continue Watching forever
 * and never advance to the next episode.
 */
export async function pushProgress(
  profileIndex: number,
  identity: WatchIdentity & { videoId: string },
  positionMs: number,
  durationMs: number,
  ended: boolean,
  progressRows: ProgressRow[],
): Promise<boolean> {
  const position = Math.max(0, Math.round(positionMs));
  const duration = Math.max(0, Math.round(durationMs));
  const completed = isComplete(position, duration, ended);
  if (!completed && position < PROGRESS_STORE_THRESHOLD_MS) return false;
  await rpc("sync_push_watch_progress", {
    p_profile_id: profileIndex,
    p_entries: [
      {
        content_id: identity.contentId,
        content_type: identity.contentType,
        video_id: identity.videoId,
        season: identity.season ?? null,
        episode: identity.episode ?? null,
        position: completed && duration > 0 ? duration : position,
        duration,
        last_watched: Date.now(),
        progress_key: resolveProgressKey(progressRows, identity),
      },
    ],
    p_origin_client_id: CLIENT_ID,
  });
  return true;
}

export function currentSession(): Session | null {
  return activeSession;
}

/**
 * Collections for the home screen.
 *
 * The row stores its payload in `collections_json`, which the backend may hand
 * back either as a JSON string or as an already-parsed object depending on the
 * column type — the desktop client handles both, so this does too.
 */
export async function loadCollections(
  profileIndex: number,
): Promise<Collection[]> {
  const rows = await rpc<Array<Record<string, unknown>>>(
    "sync_pull_collections",
    { p_profile_id: profileIndex },
  );
  const raw = rows?.[0]?.collections_json;
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => {
      const value = entry as Record<string, unknown>;
      const folders = Array.isArray(value.folders) ? value.folders : [];
      return {
        id: String(value.id ?? ""),
        title: String(value.title ?? "Collection"),
        backdropImageUrl: value.backdropImageUrl
          ? String(value.backdropImageUrl)
          : undefined,
        pinToTop: !!value.pinToTop,
        folders: folders.map((item) => {
          const folder = item as Record<string, unknown>;
          const sources = Array.isArray(folder.catalogSources)
            ? folder.catalogSources
            : [];
          return {
            id: String(folder.id ?? ""),
            title: String(folder.title ?? "Folder"),
            coverImageUrl: folder.coverImageUrl
              ? String(folder.coverImageUrl)
              : undefined,
            coverEmoji: folder.coverEmoji
              ? String(folder.coverEmoji)
              : undefined,
            tileShape: folder.tileShape ? String(folder.tileShape) : undefined,
            hideTitle: !!folder.hideTitle,
            catalogSources: sources.map((source) => {
              const entry = source as Record<string, unknown>;
              return {
                addonId: String(entry.addonId ?? ""),
                type: String(entry.type ?? ""),
                catalogId: String(entry.catalogId ?? ""),
                genre: entry.genre ? String(entry.genre) : undefined,
              };
            }),
          } satisfies CollectionFolder;
        }),
      } satisfies Collection;
    })
    .filter((collection) => collection.id);
}

/**
 * The home layout: which catalogs and collections are shown, and in what
 * order. Read-only here — this client never pushes it, so it cannot rewrite
 * what another device saved.
 *
 * Nuvio keeps this in a `home_catalog_shared` row, with `mobile` and `tv` rows
 * left over from before it was shared. The shared row wins; the legacy ones
 * only fill in when it is absent.
 */
const HOME_LAYOUT_PLATFORMS = ["home_catalog_shared", "mobile", "tv"] as const;
export const COLLECTION_KEY_PREFIX = "collection_";

export type HomeLayoutItem = {
  key: string;
  enabled: boolean;
  order: number;
  isCollection: boolean;
  customTitle: string;
};
export type HomeLayout = {
  items: HomeLayoutItem[];
  /** Ordering position by preference key, for a stable sort. */
  orderOf: Map<string, number>;
  enabledOf: Map<string, boolean>;
  /** A row renamed in Nuvio wins over the generated title. */
  customTitleOf: Map<string, string>;
  /** Appends " - Movies"/" - Series" to catalog rows. Defaults on. */
  showCatalogType: boolean;
};

/** Mirrors the desktop client's `media_type_label`. */
export function mediaTypeLabel(contentType: string): string {
  const value = contentType.trim().toLowerCase();
  if (value === "movie") return "Movies";
  if (value === "series") return "Series";
  if (value === "anime") return "Anime";
  if (value === "channel") return "Channels";
  if (value === "tv") return "TV";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

/**
 * Mirrors Kotlin's `SyncCatalogItem.preferenceKey()`. The explicit `key` wins,
 * because addon ids can themselves contain colons — which makes rebuilding the
 * three-part form ambiguous.
 */
function preferenceKey(item: Record<string, unknown>): string {
  const explicit = String(item.key ?? "").trim();
  if (explicit) return explicit;
  if (item.is_collection)
    return `${COLLECTION_KEY_PREFIX}${String(item.collection_id ?? "")}`;
  return `${String(item.addon_id ?? "")}:${String(item.type ?? "")}:${String(item.catalog_id ?? "")}`;
}

export async function loadHomeLayout(
  profileIndex: number,
): Promise<HomeLayout | null> {
  for (const platform of HOME_LAYOUT_PLATFORMS) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await rpc<Array<Record<string, unknown>>>(
        "sync_pull_home_catalog_settings",
        { p_profile_id: profileIndex, p_platform: platform },
      );
    } catch {
      // A network failure is not "no layout" — fall through and try the next
      // platform rather than treating it as an empty result.
      continue;
    }
    const raw = rows?.[0]?.settings_json;
    if (raw == null) continue;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const payload = parsed as {
      items?: Array<Record<string, unknown>>;
      show_catalog_type?: boolean;
    };
    if (!Array.isArray(payload?.items) || payload.items.length === 0) continue;

    const items: HomeLayoutItem[] = payload.items.map((item) => ({
      key: preferenceKey(item),
      enabled: item.enabled !== false,
      order: Number(item.order ?? 0),
      isCollection: !!item.is_collection,
      customTitle: String(item.custom_title ?? ""),
    }));
    items.sort((a, b) => a.order - b.order);
    return {
      items,
      orderOf: new Map(items.map((item, index) => [item.key, index])),
      enabledOf: new Map(items.map((item) => [item.key, item.enabled])),
      customTitleOf: new Map(
        items
          .filter((item) => item.customTitle.trim())
          .map((item) => [item.key, item.customTitle.trim()]),
      ),
      // Absent means older payload; the other clients default this on.
      showCatalogType: payload.show_catalog_type !== false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Delta sync
//
// Pulling every progress and watched row on each load does not scale with a
// long history. The backend keeps an append-only event log per table, so a
// client snapshots once and then asks only for what changed.
//
// The ordering below is load-bearing and mirrors Nuvio's own client: read the
// cursor BEFORE taking the snapshot. A write landing mid-snapshot is then
// replayed as a delta rather than lost between the two calls.
// ---------------------------------------------------------------------------

const DELTA_PAGE_SIZE = 900;

export type DeltaOperation = "upsert" | "delete";

async function deltaCursor(rpcName: string, profileIndex: number) {
  const value = await rpc<number | null>(rpcName, { p_profile_id: profileIndex });
  return typeof value === "number" ? value : null;
}

/**
 * Walks the event log from `since`, applying each page via `apply`.
 * Returns the new cursor. A short page means the log is caught up.
 */
async function drainDelta(
  rpcName: string,
  profileIndex: number,
  since: number,
  apply: (events: Array<Record<string, unknown>>) => void,
): Promise<number> {
  let cursor = since;
  for (;;) {
    const events = await rpc<Array<Record<string, unknown>>>(rpcName, {
      p_profile_id: profileIndex,
      p_since_event_id: cursor,
      p_limit: DELTA_PAGE_SIZE,
    });
    if (!events?.length) break;
    apply(events);
    cursor = events.reduce(
      (highest, event) => Math.max(highest, Number(event.event_id ?? 0)),
      cursor,
    );
    if (events.length < DELTA_PAGE_SIZE) break;
  }
  return cursor;
}

export const progressDeltaCursor = (profileIndex: number) =>
  deltaCursor("sync_get_watch_progress_delta_cursor", profileIndex);
export const watchedDeltaCursor = (profileIndex: number) =>
  deltaCursor("sync_get_watched_items_delta_cursor", profileIndex);

/** Applies progress events onto a snapshot, keyed the way the server keys them. */
export async function pullProgressDelta(
  profileIndex: number,
  since: number,
  rows: ProgressRow[],
): Promise<{ rows: ProgressRow[]; cursor: number }> {
  const byKey = new Map(rows.map((row) => [row.progressKey ?? "", row]));
  const cursor = await drainDelta(
    "sync_pull_watch_progress_delta",
    profileIndex,
    since,
    (events) => {
      for (const event of events) {
        const key = String(event.progress_key ?? "");
        if (String(event.operation ?? "").toLowerCase() === "delete") {
          byKey.delete(key);
          continue;
        }
        byKey.set(key, {
          contentId: String(event.content_id ?? ""),
          contentType: String(event.content_type ?? ""),
          videoId: String(event.video_id ?? ""),
          season: event.season == null ? undefined : Number(event.season),
          episode: event.episode == null ? undefined : Number(event.episode),
          positionMs: Number(event.position ?? 0),
          durationMs: Number(event.duration ?? 0),
          lastWatched: Number(event.last_watched ?? 0),
          progressKey: key,
        });
      }
    },
  );
  return { rows: [...byKey.values()].filter((row) => row.contentId), cursor };
}

export async function pullWatchedDelta(
  profileIndex: number,
  since: number,
  items: WatchedItem[],
): Promise<{ items: WatchedItem[]; cursor: number }> {
  const key = (item: { contentId: string; season?: number; episode?: number }) =>
    `${item.contentId}:${item.season ?? ""}:${item.episode ?? ""}`;
  const byKey = new Map(items.map((item) => [key(item), item]));
  const cursor = await drainDelta(
    "sync_pull_watched_items_delta",
    profileIndex,
    since,
    (events) => {
      for (const event of events) {
        const entry: WatchedItem = {
          contentId: String(event.content_id ?? ""),
          contentType: String(event.content_type ?? ""),
          title: String(event.title ?? ""),
          season: event.season == null ? undefined : Number(event.season),
          episode: event.episode == null ? undefined : Number(event.episode),
          watchedAt: Number(event.watched_at ?? 0),
        };
        if (String(event.operation ?? "").toLowerCase() === "delete")
          byKey.delete(key(entry));
        else byKey.set(key(entry), entry);
      }
    },
  );
  return { items: [...byKey.values()].filter((item) => item.contentId), cursor };
}
