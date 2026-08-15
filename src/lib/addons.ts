import type { HomeLayout } from "./account";
import type {
  AddonManifest,
  AddonRow,
  CatalogSection,
  CollectionCatalogSource,
  CollectionFolder,
  InstalledAddon,
  ManifestCatalog,
  Meta,
  Stream,
  Video,
} from "../types";

const JSON_LIMIT = 6 * 1024 * 1024;

function safeAddonUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.username || url.password)
    throw new Error("Addon URLs cannot contain credentials.");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Addons must use HTTPS (localhost may use HTTP).");
  }
  return url;
}

export function normalizeManifestUrl(value: string): string {
  const url = safeAddonUrl(value);
  if (!url.pathname.endsWith("manifest.json")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/manifest.json`;
  }
  return url.toString();
}

async function fetchJson<T>(url: string, timeoutMs = 14_000): Promise<T> {
  safeAddonUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > JSON_LIMIT) throw new Error("Addon response is too large.");
    const body = await response.text();
    if (body.length > JSON_LIMIT)
      throw new Error("Addon response is too large.");
    return JSON.parse(body) as T;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "Browser blocked this addon request (usually CORS or network failure).",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resourceUrl(
  manifestUrl: string,
  resource: string,
  type: string,
  id: string,
  extras: Record<string, string | number> = {},
): string {
  const url = new URL(normalizeManifestUrl(manifestUrl));
  const base = url.pathname.replace(/manifest\.json$/, "");
  const suffix = Object.entries(extras)
    .filter(([, value]) => value !== "")
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
  url.pathname = `${base}${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}.json`;
  return url.toString();
}

function mapVideo(value: Record<string, unknown>): Video {
  return {
    id: String(value.id ?? ""),
    title: String(value.title ?? value.name ?? "Episode"),
    season: value.season == null ? undefined : Number(value.season),
    episode: value.episode == null ? undefined : Number(value.episode),
    released: value.released ? String(value.released) : undefined,
    thumbnail: value.thumbnail ? String(value.thumbnail) : undefined,
    overview: value.overview ? String(value.overview) : undefined,
    runtime: value.runtime == null ? undefined : Number(value.runtime),
    available: value.available !== false,
  };
}

function stringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      items
        .map((item) =>
          typeof item === "object" && item
            ? String((item as Record<string, unknown>).name ?? "")
            : String(item),
        )
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function linkedNames(value: Record<string, unknown>, categories: string[]) {
  return Array.isArray(value.links)
    ? value.links
        .map((item) => item as Record<string, unknown>)
        .filter((item) =>
          categories.includes(String(item.category ?? "").toLowerCase()),
        )
        .map((item) => String(item.name ?? "").trim())
        .filter(Boolean)
    : [];
}

export function mapMeta(
  value: Record<string, unknown>,
  manifestUrl: string,
  addonName: string,
): Meta {
  const appExtras =
    typeof value.app_extras === "object" && value.app_extras
      ? (value.app_extras as Record<string, unknown>)
      : {};
  const castSource = appExtras.cast ?? value.cast;
  const cast = Array.isArray(castSource)
    ? castSource
        .map((person) => {
          if (typeof person === "string") return { name: person };
          const row = person as Record<string, unknown>;
          return {
            name: String(row.name ?? ""),
            role: row.character
              ? String(row.character)
              : row.role
                ? String(row.role)
                : undefined,
            photo: row.photo
              ? String(row.photo)
              : row.profilePath
                ? String(row.profilePath)
                : undefined,
            tmdbId: row.tmdbId == null ? undefined : Number(row.tmdbId),
          };
        })
        .filter((person) => person.name)
    : typeof castSource === "string"
      ? castSource
          .split(",")
          .map((name) => ({ name: name.trim() }))
          .filter((person) => person.name)
      : [];
  for (const name of linkedNames(value, ["cast", "actor", "actors"]))
    if (
      !cast.some((person) => person.name.toLowerCase() === name.toLowerCase())
    )
      cast.push({ name });
  const directors = [
    ...stringList(value.director),
    ...stringList(appExtras.directors),
    ...linkedNames(value, ["director", "directors"]),
  ];
  const writers = [
    ...stringList(value.writer),
    ...stringList(appExtras.writers),
    ...linkedNames(value, ["writer", "writers", "screenplay"]),
  ];
  const trailers = Array.isArray(value.trailers)
    ? value.trailers
        .map((item) => item as Record<string, unknown>)
        .map((item) => {
          const key = String(
            item.key ?? item.source ?? item.ytId ?? item.ytid ?? "",
          );
          return {
            id: String(item.id ?? key),
            key,
            name: String(item.name ?? "Trailer"),
            site: String(item.site ?? "YouTube"),
            trailerType: String(item.type ?? "Trailer"),
            displayName: item.displayName
              ? String(item.displayName)
              : item.display_name
                ? String(item.display_name)
                : undefined,
          };
        })
        .filter((item) => item.key)
    : [];
  const externalRatings = Array.isArray(value.externalRatings)
    ? value.externalRatings
        .map((item) => item as Record<string, unknown>)
        .map((item) => ({
          source: String(item.source ?? ""),
          value: Number(item.value ?? 0),
        }))
        .filter((item) => item.source && Number.isFinite(item.value))
    : [];
  return {
    id: String(value.id ?? ""),
    type: String(value.type ?? "movie"),
    name: String(value.name ?? "Untitled"),
    poster: value.poster ? String(value.poster) : undefined,
    background: value.background
      ? String(value.background)
      : value.banner
        ? String(value.banner)
        : undefined,
    banner: value.banner ? String(value.banner) : undefined,
    logo: value.logo ? String(value.logo) : undefined,
    description: value.description ? String(value.description) : undefined,
    releaseInfo: value.releaseInfo ? String(value.releaseInfo) : undefined,
    released: value.released ? String(value.released) : undefined,
    imdbRating: value.imdbRating ? String(value.imdbRating) : undefined,
    genres: Array.isArray(value.genres) ? value.genres.map(String) : [],
    runtime: value.runtime ? String(value.runtime) : undefined,
    cast,
    director: [...new Set(directors)],
    writer: [...new Set(writers)],
    status: value.status ? String(value.status) : undefined,
    ageRating: value.ageRating ? String(value.ageRating) : undefined,
    language: value.language ? String(value.language) : undefined,
    trailers,
    externalRatings,
    defaultVideoId:
      typeof value.behaviorHints === "object" && value.behaviorHints
        ? String(
            (value.behaviorHints as Record<string, unknown>).defaultVideoId ??
              "",
          ) || undefined
        : undefined,
    videos: Array.isArray(value.videos)
      ? value.videos.map((video) => mapVideo(video as Record<string, unknown>))
      : [],
    manifestUrl,
    addonName,
  };
}

function supports(
  manifest: AddonManifest,
  resource: string,
  type?: string,
): boolean {
  return (manifest.resources ?? []).some((item) => {
    if (typeof item === "string") return item === resource;
    return (
      item.name === resource &&
      (!type || !item.types?.length || item.types.includes(type))
    );
  });
}

export async function loadInstalledAddons(
  rows: AddonRow[],
): Promise<InstalledAddon[]> {
  return Promise.all(
    rows.map(async (row) => {
      try {
        const url = normalizeManifestUrl(row.url);
        const manifest = await fetchJson<AddonManifest>(url);
        return { ...row, url, name: manifest.name || row.name, manifest };
      } catch (error) {
        return {
          ...row,
          error: error instanceof Error ? error.message : "Manifest failed",
        };
      }
    }),
  );
}

/**
 * Fetches every browsable catalog across the installed addons.
 *
 * `onSection` fires as each batch lands so the home screen can paint rows
 * while the rest are still in flight — waiting for all of them was what made
 * the page sit blank on a slow connection. Batching still caps how many
 * requests are open at once; the addons are independent hosts, so a slow one
 * cannot hold up the rest.
 */
export async function loadHome(
  addons: InstalledAddon[],
  onSection?: (section: CatalogSection) => void,
  layout?: HomeLayout | null,
): Promise<{ sections: CatalogSection[]; errors: string[] }> {
  const targets = addons
    .filter((addon) => addon.enabled && addon.manifest)
    .flatMap((addon) =>
      (addon.manifest!.catalogs ?? [])
        .filter(
          (catalog) => !(catalog.extra ?? []).some((extra) => extra.isRequired),
        )
        .map((catalog) => ({
          addon,
          catalog,
          prefKey: `${addon.manifest!.id}:${catalog.type}:${catalog.id}`,
        })),
    )
    // A catalog the layout does not mention is new to this device, so it stays
    // visible — matching how the other clients treat an unknown key.
    .filter(({ prefKey }) => layout?.enabledOf.get(prefKey) !== false);

  // Ordered before batching, so the rows the user put on top are the ones
  // fetched first and therefore the ones that paint first.
  if (layout)
    targets.sort(
      (a, b) =>
        (layout.orderOf.get(a.prefKey) ?? Number.MAX_SAFE_INTEGER) -
        (layout.orderOf.get(b.prefKey) ?? Number.MAX_SAFE_INTEGER),
    );
  const sections: CatalogSection[] = [];
  const errors: string[] = [];
  for (let cursor = 0; cursor < targets.length; cursor += 4) {
    const batch = await Promise.all(
      targets.slice(cursor, cursor + 4).map(async ({ addon, catalog }) => {
        try {
          const payload = await fetchJson<{
            metas?: Array<Record<string, unknown>>;
          }>(resourceUrl(addon.url, "catalog", catalog.type, catalog.id));
          return {
            key: `${addon.manifest!.id}:${catalog.type}:${catalog.id}`,
            name: catalog.name || catalog.id,
            type: catalog.type,
            manifestUrl: addon.url,
            addonName: addon.manifest!.name,
            catalogId: catalog.id,
            items: (payload.metas ?? [])
              .slice(0, 24)
              .map((meta) => mapMeta(meta, addon.url, addon.manifest!.name)),
          } satisfies CatalogSection;
        } catch (error) {
          errors.push(
            `${addon.name ?? addon.url}: ${error instanceof Error ? error.message : "catalog failed"}`,
          );
          return null;
        }
      }),
    );
    const usable = batch.filter(
      (section): section is CatalogSection =>
        section !== null && section.items.length > 0,
    );
    sections.push(...usable);
    for (const section of usable) onSection?.(section);
  }
  return { sections, errors };
}

/** One collection source resolved against the installed addons. */
export type CollectionSourceView = {
  source: CollectionCatalogSource;
  key: string;
  label: string;
  addonName: string;
  supportsPagination: boolean;
};

/**
 * A catalog's kind, appended only when its own name does not already say it.
 * Plenty of addons name both catalogs after the service — two entries both
 * reading "HBO Max" is unusable, while "HBO Max Movies" needs nothing added.
 */
export function catalogTypeSuffix(name: string, contentType: string): string {
  const label =
    contentType === "series"
      ? "Series"
      : contentType === "movie"
        ? "Movies"
        : contentType.charAt(0).toUpperCase() + contentType.slice(1);
  const haystack = name.toLowerCase();
  const spoken = [label.toLowerCase(), contentType.toLowerCase()];
  // "Movies" should also match a name that says "Movie", and vice versa.
  if (label === "Movies") spoken.push("movie", "film");
  if (label === "Series") spoken.push("serie", "shows", "tv");
  return spoken.some((word) => haystack.includes(word)) ? "" : ` ${label}`;
}

/**
 * Labels each source the way Nuvio's folder tabs do: the catalog's own name,
 * plus its kind and the genre when the source pins one.
 */
export function describeCollectionSources(
  folder: CollectionFolder,
  addons: InstalledAddon[],
): CollectionSourceView[] {
  return folder.catalogSources.flatMap((source) => {
    const addon = addons.find(
      (item) => item.enabled && item.manifest?.id === source.addonId,
    );
    const catalog = addon?.manifest?.catalogs?.find(
      (item) => item.type === source.type && item.id === source.catalogId,
    );
    if (!addon?.manifest || !catalog) return [];
    const rawName = catalog.name?.trim() || catalog.id;
    const base = `${rawName}${catalogTypeSuffix(rawName, source.type)}`;
    const genre = source.genre?.trim();
    return [
      {
        source,
        key: `${source.addonId}:${source.type}:${source.catalogId}:${genre ?? ""}`,
        label: genre ? `${base} · ${genre}` : base,
        addonName: addon.manifest.name,
        supportsPagination: (catalog.extra ?? []).some(
          (extra) => extra.name.toLowerCase() === "skip",
        ),
      },
    ];
  });
}

/**
 * Fetches one page from each of the given sources in parallel and merges them.
 *
 * Source order is meaningful, so results are restored to it rather than left
 * in completion order, and duplicates across sources are dropped keeping the
 * first appearance.
 */
export async function loadCollectionSources(
  sources: CollectionCatalogSource[],
  addons: InstalledAddon[],
  skip = 0,
): Promise<{ items: Meta[]; errors: string[] }> {
  const errors: string[] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      const addon = addons.find(
        (item) => item.enabled && item.manifest?.id === source.addonId,
      );
      if (!addon?.manifest) {
        errors.push(`Collection addon ${source.addonId} is not installed`);
        return [] as Meta[];
      }
      const extras: Record<string, string | number> = {};
      if (source.genre?.trim()) extras.genre = source.genre.trim();
      if (skip) extras.skip = skip;
      try {
        const payload = await fetchJson<{
          metas?: Array<Record<string, unknown>>;
        }>(
          resourceUrl(
            addon.url,
            "catalog",
            source.type,
            source.catalogId,
            extras,
          ),
        );
        return (payload.metas ?? []).map((meta) =>
          mapMeta(meta, addon.url, addon.manifest!.name),
        );
      } catch (error) {
        errors.push(
          `${addon.manifest.name}: ${error instanceof Error ? error.message : "catalog failed"}`,
        );
        return [] as Meta[];
      }
    }),
  );
  const seen = new Set<string>();
  const items: Meta[] = [];
  for (const batch of results)
    for (const item of batch) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  return { items, errors };
}

export async function loadCatalog(
  section: CatalogSection,
  skip = 0,
  search = "",
): Promise<Meta[]> {
  const extras: Record<string, string | number> = {};
  if (skip) extras.skip = skip;
  if (search) extras.search = search;
  const payload = await fetchJson<{ metas?: Array<Record<string, unknown>> }>(
    resourceUrl(
      section.manifestUrl,
      "catalog",
      section.type,
      section.catalogId,
      extras,
    ),
  );
  return (payload.metas ?? []).map((meta) =>
    mapMeta(meta, section.manifestUrl, section.addonName),
  );
}

export async function resolveMeta(
  seed: Meta,
  addons: InstalledAddon[],
): Promise<Meta> {
  const ordered = [...addons].sort(
    (left, right) =>
      Number(right.url === seed.manifestUrl) -
      Number(left.url === seed.manifestUrl),
  );
  for (const addon of ordered) {
    if (
      !addon.enabled ||
      !addon.manifest ||
      !supports(addon.manifest, "meta", seed.type)
    )
      continue;
    try {
      const payload = await fetchJson<{ meta?: Record<string, unknown> }>(
        resourceUrl(addon.url, "meta", seed.type, seed.id),
      );
      if (payload.meta)
        return mapMeta(payload.meta, addon.url, addon.manifest.name);
    } catch {
      // Continue through metadata providers in installed priority order.
    }
  }
  return seed;
}

export async function searchAddons(
  query: string,
  addons: InstalledAddon[],
): Promise<Meta[]> {
  const sections = addons
    .filter((addon) => addon.enabled && addon.manifest)
    .flatMap((addon) =>
      (addon.manifest!.catalogs ?? [])
        .filter((catalog) =>
          (catalog.extra ?? []).some((extra) => extra.name === "search"),
        )
        .map(
          (catalog) =>
            ({
              key: "",
              name: catalog.name || catalog.id,
              type: catalog.type,
              manifestUrl: addon.url,
              addonName: addon.manifest!.name,
              catalogId: catalog.id,
              items: [],
            }) satisfies CatalogSection,
        ),
    );
  const results = (
    await Promise.all(
      sections
        .slice(0, 12)
        .map((section) => loadCatalog(section, 0, query).catch(() => [])),
    )
  ).flat();
  return [
    ...new Map(
      results.map((item) => [`${item.type}:${item.id}`, item]),
    ).values(),
  ];
}

export async function loadStreams(
  type: string,
  id: string,
  addons: InstalledAddon[],
): Promise<Stream[]> {
  const targets = addons.filter(
    (addon) =>
      addon.enabled &&
      addon.manifest &&
      supports(addon.manifest, "stream", type),
  );
  const groups = await Promise.all(
    targets.map(async (addon) => {
      try {
        const payload = await fetchJson<{
          streams?: Array<Record<string, unknown>>;
        }>(resourceUrl(addon.url, "stream", type, id), 20_000);
        return (payload.streams ?? []).map((stream): Stream => ({
          name: String(stream.name ?? addon.manifest!.name),
          title: String(stream.title ?? ""),
          description: String(stream.description ?? ""),
          url: stream.url ? String(stream.url) : undefined,
          externalUrl: stream.externalUrl
            ? String(stream.externalUrl)
            : undefined,
          infoHash: stream.infoHash ? String(stream.infoHash) : undefined,
          fileIdx: stream.fileIdx == null ? undefined : Number(stream.fileIdx),
          addonName: addon.manifest!.name,
          addonLogo: addon.manifest!.logo,
          behaviorHints:
            typeof stream.behaviorHints === "object"
              ? (stream.behaviorHints as Stream["behaviorHints"])
              : undefined,
        }));
      } catch {
        return [];
      }
    }),
  );
  return groups.flat();
}

export type DiscoverCatalog = {
  key: string;
  addonName: string;
  manifestUrl: string;
  contentType: string;
  catalogId: string;
  catalogName: string;
  genreOptions: string[];
  genreRequired: boolean;
  supportsPagination: boolean;
};

/**
 * Whether a catalog can be browsed without a search term, mirroring the
 * desktop client's `supports_discover`: a required `search` disqualifies it,
 * `skip` never does, and a required `genre` is fine as long as the manifest
 * actually lists options to pick from.
 */
function supportsDiscover(catalog: ManifestCatalog): boolean {
  const extras = catalog.extra ?? [];
  if (extras.some((extra) => extra.name === "search" && extra.isRequired))
    return false;
  return !extras.some((extra) => {
    if (extra.name === "genre")
      return !!extra.isRequired && (extra.options ?? []).length === 0;
    if (extra.name === "skip" || extra.name === "search") return false;
    return !!extra.isRequired;
  });
}

/**
 * Catalogs for the Discover filters, in installed-addon priority and each
 * manifest's own catalog order. Deliberately unsorted — sorting would make the
 * picker disagree with the addon configuration and with the other clients.
 */
export function discoverCatalogs(addons: InstalledAddon[]): DiscoverCatalog[] {
  const seen = new Set<string>();
  const result: DiscoverCatalog[] = [];
  for (const addon of addons) {
    if (!addon.enabled || !addon.manifest) continue;
    for (const catalog of addon.manifest.catalogs ?? []) {
      if (!supportsDiscover(catalog)) continue;
      const key = `${addon.manifest.id}:${catalog.type}:${catalog.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const genre = (catalog.extra ?? []).find(
        (extra) => extra.name === "genre",
      );
      result.push({
        key,
        addonName: addon.manifest.name,
        manifestUrl: addon.url,
        contentType: catalog.type,
        catalogId: catalog.id,
        catalogName: catalog.name?.trim() || catalog.id,
        genreOptions: genre?.options ?? [],
        genreRequired: !!genre?.isRequired,
        supportsPagination: (catalog.extra ?? []).some(
          (extra) => extra.name.toLowerCase() === "skip",
        ),
      });
    }
  }
  return result;
}

export async function loadDiscoverCatalog(
  catalog: DiscoverCatalog,
  genre?: string,
  skip = 0,
): Promise<Meta[]> {
  const extras: Record<string, string | number> = {};
  if (genre) extras.genre = genre;
  if (skip) extras.skip = skip;
  const payload = await fetchJson<{ metas?: Array<Record<string, unknown>> }>(
    resourceUrl(
      catalog.manifestUrl,
      "catalog",
      catalog.contentType,
      catalog.catalogId,
      extras,
    ),
  );
  return (payload.metas ?? []).map((meta) =>
    mapMeta(meta, catalog.manifestUrl, catalog.addonName),
  );
}
