import type { Meta, Video } from "../types";
import type { WatchIndex } from "./progress";

export type SeriesPlaybackTarget = {
  video?: Video;
  kind: "resume" | "next" | "play";
};

/** Keeps the hero action and initial season selector on the same episode. */
export function seriesPlaybackTarget(
  meta: Pick<Meta, "id" | "videos" | "selectedVideoId" | "defaultVideoId">,
  watchIndex: WatchIndex,
): SeriesPlaybackTarget {
  const episodes = meta.videos
    .filter((video) => (video.season ?? 0) > 0)
    .sort(
      (left, right) =>
        (left.season ?? 0) - (right.season ?? 0) ||
        (left.episode ?? 0) - (right.episode ?? 0),
    );
  const selected = episodes.find(
    (video) => video.id === meta.selectedVideoId,
  );
  const resumable = episodes
    .map((video) => ({
      video,
      row: watchIndex.progress.get(
        seriesWatchKey(meta.id, video.season, video.episode),
      ),
    }))
    .filter(
      (item) =>
        item.row &&
        item.row.durationMs > 0 &&
        item.row.positionMs / item.row.durationMs > 0 &&
        item.row.positionMs / item.row.durationMs < 0.9,
    )
    .sort((left, right) => right.row!.lastWatched - left.row!.lastWatched);
  const selectedResume = resumable.find(
    (item) => item.video.id === selected?.id,
  );
  const resume = selectedResume ?? resumable[0];
  if (resume) return { video: resume.video, kind: "resume" };

  const lastWatchedIndex = episodes.reduce(
    (last, video, index) =>
      watchIndex.watched.has(
        seriesWatchKey(meta.id, video.season, video.episode),
      )
        ? index
        : last,
    -1,
  );
  const next = episodes[lastWatchedIndex + 1];
  if (lastWatchedIndex >= 0 && next)
    return { video: next, kind: "next" };

  return {
    video:
      selected ??
      episodes.find((video) => video.id === meta.defaultVideoId) ??
      episodes[0] ??
      meta.videos[0],
    kind: "play",
  };
}

function seriesWatchKey(
  contentId: string,
  season?: number,
  episode?: number,
) {
  return season != null && episode != null
    ? `${contentId}:s${season}e${episode}`
    : contentId;
}
