import {
  ArrowLeft,
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Play,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { loadStreams, resolveMeta } from "../lib/addons";
import { assessPlayback } from "../lib/playback";
import {
  needsProbe,
  probeSources,
  statusFor,
  subscribeSourceProbes,
} from "../lib/sourceProbe";
import { episodePercent, watchKey, type WatchIndex } from "../lib/progress";
import { useLongPress } from "../lib/useLongPress";
import { useScrollLock } from "../lib/useScrollLock";
import { useSwipeBack } from "../lib/useSwipeBack";
import type { InstalledAddon, Meta, Stream, Video } from "../types";
import { ContextMenu } from "./ContextMenu";

export function Details({
  seed,
  addons,
  inLibrary,
  watchIndex,
  onClose,
  onLibrary,
  onPlay,
  onSetWatched,
}: {
  seed: Meta;
  addons: InstalledAddon[];
  inLibrary: boolean;
  watchIndex: WatchIndex;
  onClose(): void;
  onLibrary(meta: Meta): void;
  onPlay(stream: Stream, meta: Meta, video?: Video): void;
  onSetWatched(meta: Meta, video: Video | undefined, watched: boolean): void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; video: Video } | null>(
    null,
  );
  useScrollLock();
  const swipeRef = useSwipeBack<HTMLDivElement>(onClose);
  const [meta, setMeta] = useState(seed);
  const movieWatched = watchIndex.watched.has(watchKey(meta.id));
  const [busy, setBusy] = useState(true);
  // Only hold back content we do not already have: a seed that arrived with
  // episodes would otherwise flicker into a spinner.
  const pending = busy && meta.videos.length === 0 && meta.cast.length === 0;
  const [sourceOpen, setSourceOpen] = useState(false);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceVideo, setSourceVideo] = useState<Video | undefined>();
  // Probe results live in a module cache, so this only forces a re-render.
  const [, setProbeTick] = useState(0);
  useEffect(
    () => subscribeSourceProbes(() => setProbeTick((tick) => tick + 1)),
    [],
  );
  const seasons = useMemo(
    () =>
      [...new Set(meta.videos.map((video) => video.season ?? 0))].sort(
        (a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b),
      ),
    [meta],
  );
  const [season, setSeason] = useState<number | undefined>();
  useEffect(() => {
    let live = true;
    setBusy(true);
    resolveMeta(seed, addons)
      .then((next) => {
        if (live) {
          setMeta(next);
          const first = [
            ...new Set(next.videos.map((video) => video.season ?? 0)),
          ].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))[0];
          const selected = next.videos.find(
            (video) => video.id === seed.selectedVideoId,
          );
          setSeason(selected?.season ?? first);
        }
      })
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [seed, addons]);
  async function sources(video?: Video) {
    setSourceVideo(video);
    setSourceOpen(true);
    setSourceBusy(true);
    setStreams([]);
    try {
      setStreams(await loadStreams(meta.type, video?.id || meta.id, addons));
    } finally {
      setSourceBusy(false);
    }
  }
  return (
    <div
      className={sourceOpen ? "detail-view has-sheet" : "detail-view"}
      ref={swipeRef}
    >
      <button className="circle-button back" onClick={onClose}>
        <ArrowLeft />
      </button>
      <div
        className="detail-hero"
        style={
          meta.background
            ? {
                backgroundImage: `linear-gradient(90deg, rgba(5,7,9,.98), rgba(5,7,9,.38)), linear-gradient(0deg, #080a0d, transparent 60%), url("${meta.background.replace(/"/g, "%22")}")`,
              }
            : undefined
        }
      >
        <div className="detail-copy">
          {meta.logo ? (
            <img className="detail-logo" src={meta.logo} alt={meta.name} />
          ) : (
            <h1>{meta.name}</h1>
          )}
          <div className="hero-meta">
            <span>{meta.releaseInfo}</span>
            <span>{meta.runtime}</span>
            {meta.ageRating && <span>{meta.ageRating}</span>}
            {meta.status && <span>{meta.status}</span>}
          </div>
          {(meta.imdbRating || meta.externalRatings.length > 0) && (
            <div className="detail-ratings">
              {meta.imdbRating && (
                <span>
                  <b>IMDb</b> {meta.imdbRating}
                </span>
              )}
              {meta.externalRatings.map((rating) => (
                <span key={rating.source}>
                  <b>{rating.source}</b> {rating.value}
                </span>
              ))}
            </div>
          )}
          <p>{meta.description}</p>
          <div className="chips">
            {meta.genres.map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
          <div className="detail-actions">
            <button
              className="primary"
              onClick={() =>
                sources(
                  meta.videos.find(
                    (video) => video.id === seed.selectedVideoId,
                  ) ??
                    meta.videos.find(
                      (video) => video.id === meta.defaultVideoId,
                    ) ??
                    meta.videos.find((video) => (video.season ?? 0) > 0) ??
                    meta.videos[0],
                )
              }
            >
              <Play size={18} fill="currentColor" />{" "}
              {meta.type === "series" ? "Choose episode" : "Watch now"}
            </button>
            <button
              className={inLibrary ? "icon-pill active" : "icon-pill"}
              aria-pressed={inLibrary}
              title={inLibrary ? "In your library" : "Add to library"}
              aria-label={inLibrary ? "In your library" : "Add to library"}
              onClick={() => onLibrary(meta)}
            >
              {inLibrary ? <Check size={20} /> : <Plus size={20} />}
            </button>
            {/* Series are marked per episode from the list below, so the
                title-level toggle is only meaningful for a movie. */}
            {meta.type !== "series" && (
              <button
                className={movieWatched ? "icon-pill active" : "icon-pill"}
                aria-pressed={movieWatched}
                title={movieWatched ? "Mark as unwatched" : "Mark as watched"}
                aria-label={movieWatched ? "Mark as unwatched" : "Mark as watched"}
                onClick={() => onSetWatched(meta, undefined, !movieWatched)}
              >
                {movieWatched ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {pending ? (
        <div className="detail-loading" role="status">
          <i className="mini-spinner" />
          <span>
            {meta.type === "series" ? "Loading episodes…" : "Loading details…"}
          </span>
        </div>
      ) : (
        <>
      {(meta.director.length > 0 ||
        meta.writer.length > 0 ||
        meta.language) && (
        <section className="detail-credits">
          {meta.director.length > 0 && (
            <div>
              <span className="eyebrow">DIRECTOR</span>
              <strong>{meta.director.join(", ")}</strong>
            </div>
          )}
          {meta.writer.length > 0 && (
            <div>
              <span className="eyebrow">WRITER</span>
              <strong>{meta.writer.join(", ")}</strong>
            </div>
          )}
          {meta.language && (
            <div>
              <span className="eyebrow">LANGUAGE</span>
              <strong>{meta.language}</strong>
            </div>
          )}
        </section>
      )}
      {meta.type === "series" && (
        <section className="episodes">
          <header>
            <div>
              <span className="eyebrow">EPISODES</span>
              <h2>{meta.name}</h2>
            </div>
            <select
              value={season ?? ""}
              onChange={(event) => setSeason(Number(event.target.value))}
            >
              {seasons.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "Specials" : `Season ${value}`}
                </option>
              ))}
            </select>
          </header>
          <div className="episode-list">
            {meta.videos
              .filter((video) => (video.season ?? 0) === season)
              .map((video) => (
                <EpisodeRow
                  key={video.id}
                  video={video}
                  watched={watchIndex.watched.has(
                    watchKey(meta.id, video.season, video.episode),
                  )}
                  percent={episodePercent(
                    watchIndex,
                    watchKey(meta.id, video.season, video.episode),
                  )}
                  onPlay={() => sources(video)}
                  onMenu={(x, y) => setMenu({ x, y, video })}
                />
              ))}
          </div>
        </section>
      )}
      {meta.cast.length > 0 && (
        <section className="cast">
          <span className="eyebrow">CAST</span>
          <h2>Actors & creators</h2>
          <div>
            {meta.cast.map((person, index) => (
              <article key={`${person.name}:${index}`}>
                {person.photo ? (
                  <img src={person.photo} alt="" loading="lazy" />
                ) : (
                  <span>{person.name.slice(0, 1)}</span>
                )}
                <strong>{person.name}</strong>
                <small>{person.role}</small>
              </article>
            ))}
          </div>
        </section>
      )}
      {meta.trailers.length > 0 && (
        <section className="detail-trailers">
          <span className="eyebrow">VIDEOS</span>
          <h2>Trailers & extras</h2>
          <div>
            {meta.trailers.slice(0, 18).map((trailer) => {
              const youtube =
                !trailer.site || trailer.site.toLowerCase() === "youtube";
              const href = youtube
                ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}`
                : trailer.key;
              return (
                <a
                  key={trailer.id || trailer.key}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>
                    {youtube && (
                      <img
                        src={`https://i.ytimg.com/vi/${encodeURIComponent(trailer.key)}/hqdefault.jpg`}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <Play fill="currentColor" />
                  </span>
                  <strong>{trailer.displayName || trailer.name}</strong>
                  <small>{trailer.trailerType}</small>
                </a>
              );
            })}
          </div>
        </section>
      )}
        </>
      )}
      {menu &&
        (() => {
          const key = watchKey(meta.id, menu.video.season, menu.video.episode);
          const isWatched = watchIndex.watched.has(key);
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              items={[
                {
                  label: isWatched ? "Mark as unwatched" : "Mark as watched",
                  icon: isWatched ? <EyeOff size={16} /> : <Eye size={16} />,
                  onSelect: () => onSetWatched(meta, menu.video, !isWatched),
                },
                {
                  label: "Play",
                  icon: <Play size={16} />,
                  onSelect: () => sources(menu.video),
                },
              ]}
            />
          );
        })()}
      {sourceOpen && (
        <div className="sheet-backdrop" onClick={() => setSourceOpen(false)}>
          <section
            className="source-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">PLAYBACK</span>
                <h2>Choose a source</h2>
              </div>
              <div className="source-sheet-tools">
                <button
                  className="secondary"
                  onClick={() =>
                    void probeSources(
                      streams
                        .map((item) => item.url || item.externalUrl || "")
                        .filter((target) =>
                          needsProbe(
                            target,
                            streams.find(
                              (item) =>
                                (item.url || item.externalUrl) === target,
                            )?.behaviorHints?.filename,
                          ),
                        ),
                    )
                  }
                >
                  Check playability
                </button>
                <button
                  className="circle-button"
                  onClick={() => setSourceOpen(false)}
                >
                  <X />
                </button>
              </div>
            </header>
            {sourceBusy ? (
              <div className="sheet-loading">Fetching addon sources…</div>
            ) : streams.length ? (
              <div className="source-list">
                {streams.map((stream, index) => (
                  <article key={`${stream.addonName}:${index}`}>
                    <button
                      className="source-main"
                      disabled={!stream.url && !stream.externalUrl}
                      onClick={() => onPlay(stream, meta, sourceVideo)}
                    >
                      <span>
                        {stream.addonLogo ? (
                          <img src={stream.addonLogo} alt="" />
                        ) : (
                          <Play size={18} />
                        )}
                      </span>
                      <div>
                        <strong>{stream.name || stream.addonName}</strong>
                        <p>
                          {stream.title ||
                            stream.description ||
                            stream.behaviorHints?.filename}
                        </p>
                        <small>
                          {stream.addonName}
                          {(() => {
                            const target =
                              stream.url || stream.externalUrl || "";
                            const probed = statusFor(target);
                            // A probe read the container, so it outranks any
                            // guess made from the file name.
                            if (probed)
                              return (
                                <>
                                  {" · "}
                                  <b className={`probe-state-${probed.state}`}>
                                    {probed.label}
                                  </b>
                                  {` · ${probed.detail}`}
                                </>
                              );
                            const verdict = assessPlayback(
                              target,
                              stream.behaviorHints?.filename,
                            );
                            if (!verdict.playable)
                              return " · Needs an external player";
                            if (verdict.audioRisk) return " · Audio may not play";
                            return stream.behaviorHints?.notWebReady
                              ? " · External player recommended"
                              : "";
                          })()}
                        </small>
                      </div>
                    </button>
                    {stream.url && (
                      <div className="source-tools">
                        <button
                          onClick={() =>
                            navigator.clipboard.writeText(stream.url!)
                          }
                        >
                          <Copy size={16} /> Copy
                        </button>
                        <a href={stream.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={16} /> Open
                        </a>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="sheet-loading">
                No sources were returned by the installed addons.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * One episode. The whole row is the play target; a right-click or a touch
 * hold opens the menu instead. Watched state shows as a check badge, and a
 * partial resume point as a bar across the bottom of the thumbnail.
 */
function EpisodeRow({
  video,
  watched,
  percent,
  onPlay,
  onMenu,
}: {
  video: Video;
  watched: boolean;
  percent: number;
  onPlay(): void;
  onMenu(x: number, y: number): void;
}) {
  const hold = useLongPress(onMenu);
  return (
    <button
      className={watched ? "episode-row is-watched" : "episode-row"}
      onClick={() => {
        // A hold already opened the menu; the tap that ends it is not a play.
        if (hold.consumedTap()) return;
        onPlay();
      }}
      onContextMenu={hold.onContextMenu}
      onTouchStart={hold.onTouchStart}
      onTouchMove={hold.onTouchMove}
      onTouchEnd={hold.onTouchEnd}
      onTouchCancel={hold.onTouchCancel}
    >
      <span className="episode-thumb">
        {video.thumbnail ? (
          <img src={video.thumbnail} alt="" loading="lazy" />
        ) : (
          <span className="episode-placeholder" />
        )}
        {watched && (
          <i className="episode-watched" aria-label="Watched">
            <Check size={13} strokeWidth={3.4} />
          </i>
        )}
        {percent > 0 && percent < 90 && (
          <i className="episode-progress" style={{ width: `${percent}%` }} />
        )}
      </span>
      <span>
        <small>
          S{video.season} E{video.episode}
          {video.released
            ? ` · ${new Date(video.released).toLocaleDateString()}`
            : ""}
        </small>
        <strong>{video.title}</strong>
        <p>{video.overview}</p>
      </span>
      <Play size={20} />
    </button>
  );
}
