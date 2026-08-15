import { Check, Play } from "lucide-react";
import { memo } from "react";
import { watchKey, type WatchIndex } from "../lib/progress";
import type { CatalogSection, Meta } from "../types";

/**
 * Memoised because the grids re-render whenever the watch index changes, and
 * a catalog page can hold several hundred of these.
 */
export const PosterCard = memo(function PosterCard({
  item,
  index,
  onOpen,
}: {
  item: Meta;
  index: WatchIndex;
  // Takes the item rather than a closure: an inline `() => onOpen(item)` at
  // the call site is a new function on every render, which defeats `memo` and
  // made every already-rendered card re-render on each progressive chunk.
  onOpen(item: Meta): void;
}) {
  const onClick = () => onOpen(item);
  const progress = index.byContent.get(item.id);
  const percentage = progress?.durationMs
    ? Math.min(100, (progress.positionMs / progress.durationMs) * 100)
    : 0;
  // A movie is watched outright; a series is only badged once nothing is
  // part-watched, which the row-level index cannot tell us, so keep it to the
  // explicit movie case rather than badging a show mid-season.
  const watched =
    item.type !== "series" && index.watched.has(watchKey(item.id));
  return (
    <button
      className="poster-card"
      onClick={onClick}
      aria-label={`Open ${item.name}`}
    >
      <span className="poster-image-wrap">
        {item.poster ? (
          <img src={item.poster} alt="" loading="lazy" />
        ) : (
          <span className="poster-fallback">{item.name.slice(0, 1)}</span>
        )}
        {watched && (
          <span className="watched-dot">
            <Check size={15} />
          </span>
        )}
        {percentage > 0 && percentage < 98 && (
          <span className="poster-progress">
            <i style={{ width: `${percentage}%` }} />
          </span>
        )}
      </span>
      <strong>{item.name}</strong>
      <small>{item.releaseInfo || item.type}</small>
    </button>
  );
});

export function MediaRow({
  section,
  index,
  onOpen,
  onSeeAll,
}: {
  section: CatalogSection;
  index: WatchIndex;
  onOpen(item: Meta): void;
  onSeeAll(): void;
}) {
  return (
    <section className="media-section">
      <header>
        <div>
          <h2>{section.name}</h2>
          <span>{section.addonName}</span>
        </div>
        <button onClick={onSeeAll}>See all</button>
      </header>
      <div className="media-row">
        {section.items.map((item) => (
          <PosterCard
            key={`${item.type}:${item.id}`}
            item={item}
            index={index}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

export function Hero({ item, onOpen }: { item: Meta; onOpen(): void }) {
  return (
    <section
      className="hero"
      style={
        item.background
          ? {
              backgroundImage: `linear-gradient(90deg, rgba(5,7,9,.98) 0%, rgba(5,7,9,.67) 46%, rgba(5,7,9,.12) 100%), linear-gradient(0deg, #080a0d 0%, transparent 55%), url("${item.background.replace(/"/g, "%22")}")`,
            }
          : undefined
      }
    >
      <div className="hero-copy">
        {item.logo ? (
          <img src={item.logo} className="title-logo" alt={item.name} />
        ) : (
          <h1>{item.name}</h1>
        )}
        <div className="hero-meta">
          <span>{item.releaseInfo}</span>
          {item.imdbRating && <span>★ {item.imdbRating}</span>}
          <span>{item.type === "series" ? "Series" : "Movie"}</span>
        </div>
        <p>{item.description}</p>
        <button className="primary" onClick={onOpen}>
          <Play size={18} fill="currentColor" /> View details
        </button>
      </div>
    </section>
  );
}
