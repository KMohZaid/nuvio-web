import type { Meta, ProgressRow, Video, WatchedItem } from "../types";

export type ContinueCard = {
  item: Meta;
  video?: Video;
  progress?: ProgressRow;
  nextUp: boolean;
  lastWatched: number;
};
const percent = (entry: ProgressRow) =>
  entry.durationMs > 0
    ? Math.max(0, Math.min(100, (entry.positionMs / entry.durationMs) * 100))
    : 0;
const completed = (entry: ProgressRow) => percent(entry) >= 90;
const isSeries = (type: string) =>
  ["series", "show", "tv", "tvshow", "anime"].includes(type.toLowerCase());
const entriesFor = (entries: ProgressRow[], id: string) =>
  entries
    .filter((entry) => entry.contentId === id)
    .sort((a, b) => b.lastWatched - a.lastWatched);

export function buildContinueWatching(
  entries: ProgressRow[],
  watched: WatchedItem[],
  metadata: Meta[],
): ContinueCard[] {
  const metaById = new Map(metadata.map((item) => [item.id, item]));
  const ids = new Set([
    ...entries.map((entry) => entry.contentId),
    ...watched.map((entry) => entry.contentId),
  ]);
  const cards: ContinueCard[] = [];
  for (const id of ids) {
    const item = metaById.get(id);
    if (!item) continue;
    const titleEntries = entriesFor(entries, id);
    const resumable = titleEntries.find(
      (entry) => percent(entry) > 0 && !completed(entry),
    );
    if (resumable) {
      const video =
        item.videos.find((entry) => entry.id === resumable.videoId) ??
        item.videos.find(
          (entry) =>
            entry.season === resumable.season &&
            entry.episode === resumable.episode,
        );
      cards.push({
        item,
        video,
        progress: resumable,
        nextUp: false,
        lastWatched: resumable.lastWatched,
      });
      continue;
    }
    if (!isSeries(item.type)) continue;
    const seeds = [
      ...titleEntries
        .filter(
          (entry) =>
            entry.season != null && entry.episode != null && completed(entry),
        )
        .map((entry) => ({
          season: entry.season!,
          episode: entry.episode!,
          at: entry.lastWatched,
        })),
      ...watched
        .filter(
          (entry) =>
            entry.contentId === id &&
            entry.season != null &&
            entry.episode != null,
        )
        .map((entry) => ({
          season: entry.season!,
          episode: entry.episode!,
          at: entry.watchedAt,
        })),
    ].sort(
      (a, b) => b.season - a.season || b.episode - a.episode || b.at - a.at,
    );
    const seed = seeds[0];
    if (!seed) continue;
    const now = Date.now();
    const next = [...item.videos]
      .filter(
        (entry) =>
          (entry.season ?? 0) > 0 &&
          entry.available !== false &&
          (!entry.released || new Date(entry.released).getTime() <= now),
      )
      .sort(
        (a, b) =>
          (a.season ?? 0) - (b.season ?? 0) ||
          (a.episode ?? 0) - (b.episode ?? 0),
      )
      .find(
        (entry) =>
          (entry.season ?? 0) > seed.season ||
          ((entry.season ?? 0) === seed.season &&
            (entry.episode ?? 0) > seed.episode),
      );
    if (next)
      cards.push({ item, video: next, nextUp: true, lastWatched: seed.at });
  }
  // Deliberately generous: the row scrolls, so a longer list costs nothing,
  // and truncating it is what made titles look like they had gone missing.
  return cards.sort((a, b) => b.lastWatched - a.lastWatched).slice(0, 40);
}

/** Stable identity for one episode (or a movie, with no season/episode). */
export const watchKey = (
  contentId: string,
  season?: number,
  episode?: number,
) =>
  season != null && episode != null
    ? `${contentId}:s${season}e${episode}`
    : contentId;

export type WatchIndex = {
  /** Episodes and movies explicitly marked watched. */
  watched: Set<string>;
  /** Resume points, by the same key. */
  progress: Map<string, ProgressRow>;
  /** Newest resume point per title, for poster-level progress bars. */
  byContent: Map<string, ProgressRow>;
};

/**
 * One pass over both tables, so lookups during render are O(1). The previous
 * `progress.find(...)` per card was O(rows) per poster, which is what made
 * large grids stall.
 */
export function buildWatchIndex(
  entries: ProgressRow[],
  watched: WatchedItem[],
): WatchIndex {
  const index: WatchIndex = {
    watched: new Set(),
    progress: new Map(),
    byContent: new Map(),
  };
  for (const item of watched)
    index.watched.add(watchKey(item.contentId, item.season, item.episode));
  for (const row of entries) {
    const key = watchKey(row.contentId, row.season, row.episode);
    const existing = index.progress.get(key);
    if (!existing || row.lastWatched > existing.lastWatched)
      index.progress.set(key, row);
    // A finished episode counts as watched even without a watched-items row.
    if (completed(row)) index.watched.add(key);
    const newest = index.byContent.get(row.contentId);
    if (!newest || row.lastWatched > newest.lastWatched)
      index.byContent.set(row.contentId, row);
  }
  return index;
}

/** Percentage watched for one episode, 0 when there is no resume point. */
export function episodePercent(index: WatchIndex, key: string): number {
  const row = index.progress.get(key);
  return row ? percent(row) : 0;
}

export const progressPercent = (card: ContinueCard) =>
  card.progress ? percent(card.progress) : 0;
export function remainingLabel(entry?: ProgressRow) {
  if (!entry?.durationMs) return "Continue";
  const minutes = Math.max(
    1,
    Math.ceil((entry.durationMs - entry.positionMs) / 60000),
  );
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours
    ? `${hours}h${rest ? ` ${rest}m` : ""} left`
    : `${minutes}m left`;
}
