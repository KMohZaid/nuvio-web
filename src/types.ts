export type BackendConfig = { url: string; key: string; selfHosted: boolean };
export type AuthUser = { id: string; email?: string };
export type Session = {
  accessToken: string;
  user: AuthUser;
  backend: BackendConfig;
};
export type Profile = {
  id: string;
  userId: string;
  profileIndex: number;
  name: string;
  avatarColorHex: string;
  avatarId?: string;
  avatarUrl?: string;
};
export type AvatarCatalogItem = {
  id: string;
  displayName: string;
  category: string;
  sortOrder: number;
  backgroundColor?: string;
  imageUrl: string;
};
export type AddonRow = {
  url: string;
  name?: string;
  enabled: boolean;
  sortOrder: number;
};
export type ManifestCatalog = {
  id: string;
  type: string;
  name?: string;
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
};
export type AddonManifest = {
  id: string;
  name: string;
  version?: string;
  logo?: string;
  types?: string[];
  idPrefixes?: string[];
  resources?: Array<
    string | { name: string; types?: string[]; idPrefixes?: string[] }
  >;
  catalogs?: ManifestCatalog[];
  behaviorHints?: {
    configurable?: boolean;
    configurationRequired?: boolean;
  };
};
export type InstalledAddon = AddonRow & {
  manifest?: AddonManifest;
  error?: string;
};
export type Video = {
  id: string;
  title: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string;
  overview?: string;
  runtime?: number;
  available?: boolean;
};
export type Person = {
  name: string;
  role?: string;
  photo?: string;
  tmdbId?: number;
};
export type MetaTrailer = {
  id: string;
  key: string;
  name: string;
  site: string;
  trailerType: string;
  displayName?: string;
};
export type ExternalRating = { source: string; value: number };
export type Meta = {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  banner?: string;
  /** Stremio's posterShape: "poster" | "landscape" | "square". */
  posterShape?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  released?: string;
  imdbRating?: string;
  genres: string[];
  runtime?: string;
  cast: Person[];
  director: string[];
  writer: string[];
  status?: string;
  ageRating?: string;
  language?: string;
  trailers: MetaTrailer[];
  externalRatings: ExternalRating[];
  defaultVideoId?: string;
  selectedVideoId?: string;
  videos: Video[];
  manifestUrl: string;
  addonName: string;
};
export type CatalogSection = {
  key: string;
  name: string;
  type: string;
  manifestUrl: string;
  addonName: string;
  catalogId: string;
  items: Meta[];
};
export type Stream = {
  name: string;
  title: string;
  description: string;
  url?: string;
  externalUrl?: string;
  infoHash?: string;
  fileIdx?: number;
  addonName: string;
  addonLogo?: string;
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    proxyHeaders?: { request?: Record<string, string> };
  };
};
export type LibraryItem = Meta & { addedAt?: number };
export type ProgressRow = {
  contentId: string;
  contentType: string;
  videoId: string;
  season?: number;
  episode?: number;
  positionMs: number;
  durationMs: number;
  lastWatched: number;
  /** The server's own key for this row. Opaque — reuse it rather than
   *  rebuilding it, or a delete/update creates a duplicate row instead. */
  progressKey?: string;
};
export type WatchedItem = {
  contentId: string;
  contentType: string;
  title: string;
  season?: number;
  episode?: number;
  watchedAt: number;
};
export type ExternalPlayerMode =
  | "internal"
  | "copy"
  | "vlc"
  | "outplayer"
  | "infuse"
  | "m3u";
export type NavKey =
  | "home"
  | "discover"
  | "library"
  | "addons"
  | "remuxLab"
  | "settings";

/** One catalog feeding a collection folder. */
export type CollectionCatalogSource = {
  addonId: string;
  type: string;
  catalogId: string;
  genre?: string;
};
export type CollectionFolder = {
  id: string;
  title: string;
  coverImageUrl?: string;
  coverEmoji?: string;
  tileShape?: string;
  hideTitle?: boolean;
  catalogSources: CollectionCatalogSource[];
};
export type Collection = {
  id: string;
  title: string;
  backdropImageUrl?: string;
  pinToTop: boolean;
  folders: CollectionFolder[];
};
