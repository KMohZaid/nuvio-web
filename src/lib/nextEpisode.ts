import type { Stream, Video } from "../types";

/**
 * When the next episode is offered, and which source it plays from.
 *
 * A port of `PlayerNextEpisodeRules` and the binge-group selection around it,
 * so a series continues the same way here as it does on the other clients —
 * same moment, same source, same order.
 */

/** Nuvio's default: offer at 97% watched. */
export const NEXT_EPISODE_PERCENT = 97;

export type EpisodeRef = Pick<Video, "id" | "season" | "episode" | "title" | "thumbnail" | "released">;

/**
 * The episode after this one, in season and episode order.
 *
 * Ordered rather than trusted as given: an addon may list episodes in any
 * order, and specials without a season or episode number are not part of the
 * run at all.
 */
export function resolveNextEpisode<T extends EpisodeRef>(
  videos: readonly T[],
  currentSeason?: number,
  currentEpisode?: number,
): T | null {
  if (currentSeason == null || currentEpisode == null) return null;
  const ordered = videos
    .filter((video) => video.season != null && video.episode != null)
    .sort(
      (left, right) =>
        (left.season ?? 0) - (right.season ?? 0) ||
        (left.episode ?? 0) - (right.episode ?? 0),
    );
  const current = ordered.findIndex(
    (video) =>
      video.season === currentSeason && video.episode === currentEpisode,
  );
  if (current < 0) return null;
  return ordered[current + 1] ?? null;
}

/**
 * Whether an episode has aired.
 *
 * An addon commonly lists a whole season including episodes that do not exist
 * yet, and offering to play one leads nowhere. Anything unparseable is treated
 * as aired, since refusing to continue on a malformed date would be worse than
 * offering an episode that turns out to be missing.
 */
export function hasEpisodeAired(released?: string, now = new Date()): boolean {
  const value = released?.trim();
  if (!value || value.length < 10) return true;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day))
    return true;
  // Both sides local, as the other clients compare them. Parsing the air date
  // as UTC and comparing it against a local "today" moves the answer by a day
  // for anyone west of Greenwich, which is a whole evening of an episode being
  // called unaired.
  const airs = new Date(year, month - 1, day).getTime();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return airs <= today;
}

/**
 * Whether the card should be showing at this position.
 *
 * The percentage is clamped to 97–100 as Nuvio clamps it: earlier than that
 * and the card covers the end of the episode rather than the credits.
 */
export function shouldShowNextEpisode(
  positionMs: number,
  durationMs: number,
  percent = NEXT_EPISODE_PERCENT,
  /** Seconds. Where the credits begin, when that is known. */
  creditsStartSeconds?: number | null,
): boolean {
  if (durationMs <= 0 || positionMs <= 0) return false;
  // Known credits beat the threshold, as they do in Nuvio: an episode with a
  // long "next time" tail reaches 97% well after the story has finished, and
  // one with no tail at all reaches it in the middle of the last scene.
  if (creditsStartSeconds != null && creditsStartSeconds > 0)
    return positionMs / 1000 >= creditsStartSeconds;
  const clamped = Math.min(100, Math.max(97, percent));
  return positionMs / durationMs >= clamped / 100;
}

/**
 * The source to continue from.
 *
 * A binge group names a source that can serve a whole run — the same release
 * from the same addon — so continuing within it keeps the quality, the audio
 * and the host you already chose, rather than restarting the choice each
 * episode. Nothing in the group means the ordinary first choice, which is what
 * the list is already sorted to.
 */
export function pickBingeStream(
  streams: readonly Stream[],
  bingeGroup?: string,
): Stream | null {
  const playable = streams.filter((stream) => stream.url || stream.externalUrl);
  if (!playable.length) return null;
  if (bingeGroup) {
    const same = playable.find(
      (stream) => stream.behaviorHints?.bingeGroup === bingeGroup,
    );
    if (same) return same;
  }
  return playable[0];
}
