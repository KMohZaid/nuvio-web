/**
 * Per-episode scores, fetched the way Nuvio fetches them.
 *
 * No addon supplies these. Cinemeta sends "0" for most shows and AIOMetadata
 * sends nothing at all, which is why reading the field off the video was never
 * going to work — official Nuvio calls a separate ratings service keyed by the
 * show's IMDb id, with its TMDB id as a fallback.
 *
 * Mirrors `ImdbEpisodeRatingsRepository` / `SeriesGraphApi`: the same endpoint
 * shape, the same "a zero vote average means no rating" rule, and the same
 * half-hour cache.
 */

const PRIMARY = import.meta.env.VITE_IMDB_RATINGS_BASE_URL ?? "";
const FALLBACK = import.meta.env.VITE_IMDB_RATINGS_FALLBACK_URL ?? "";
const CACHE_TTL_MS = 30 * 60 * 1000;

type SeasonRatings = {
  episodes?: Array<{
    season_number?: number;
    episode_number?: number;
    vote_average?: number;
  }>;
};

/** Keyed `season:episode`, matching how the episode list looks them up. */
export type EpisodeRatings = Map<string, number>;

const cache = new Map<string, { at: number; ratings: EpisodeRatings }>();
const inFlight = new Map<string, Promise<EpisodeRatings>>();

/** `tt1234:1:1` and `tt1234` are the same show; anything else is not an id. */
export function normalizeImdbId(value?: string): string | undefined {
  const id = value?.trim().split(":")[0];
  return id?.toLowerCase().startsWith("tt") ? id : undefined;
}

async function request(baseUrl: string, showId: string): Promise<EpisodeRatings> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const ratings: EpisodeRatings = new Map();
  if (!base) return ratings;
  try {
    const response = await fetch(`${base}/api/shows/${showId}/season-ratings`, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return ratings;
    const payload = (await response.json()) as SeasonRatings[];
    for (const season of Array.isArray(payload) ? payload : [])
      for (const episode of season.episodes ?? []) {
        const { season_number: s, episode_number: e, vote_average: score } = episode;
        // Zero is "no rating" here, exactly as it is in the addon payloads.
        if (s == null || e == null || !score || score <= 0) continue;
        ratings.set(`${s}:${e}`, score);
      }
  } catch {
    // A missing score is not worth failing an episode list over.
  }
  return ratings;
}

/**
 * Ratings for one series. Returns an empty map when no service is configured,
 * so the badge simply does not appear rather than the list breaking.
 */
export async function loadEpisodeRatings(
  imdbId?: string,
  tmdbId?: number,
): Promise<EpisodeRatings> {
  const imdb = normalizeImdbId(imdbId);
  const key = imdb ?? (tmdbId != null ? `tmdb:${tmdbId}` : "");
  if (!key || (!PRIMARY && !FALLBACK)) return new Map();

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ratings;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    let ratings: EpisodeRatings = new Map();
    if (imdb && PRIMARY) ratings = await request(PRIMARY, imdb);
    // The fallback is keyed by TMDB id and only consulted when the primary
    // returned nothing, as in Nuvio.
    if (!ratings.size && tmdbId != null && FALLBACK)
      ratings = await request(FALLBACK, String(tmdbId));
    cache.set(key, { at: Date.now(), ratings });
    inFlight.delete(key);
    return ratings;
  })();
  inFlight.set(key, task);
  return task;
}
