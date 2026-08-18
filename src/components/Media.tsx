import {
  Eye, Check, Play } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { watchKey, type WatchIndex } from "../lib/progress";
import { useDragScroll } from "../lib/useDragScroll";
import { useLongPress } from "../lib/useLongPress";
import type { CatalogSection, Meta } from "../types";

export type MediaMenuHandler = (item: Meta, x: number, y: number) => void;

/**
 * Memoised because the grids re-render whenever the watch index changes, and
 * a catalog page can hold several hundred of these.
 */
export const PosterCard = memo(function PosterCard({
  item,
  index,
  onOpen,
  onMenu,
}: {
  item: Meta;
  index: WatchIndex;
  // Takes the item rather than a closure: an inline `() => onOpen(item)` at
  // the call site is a new function on every render, which defeats `memo` and
  // made every already-rendered card re-render on each progressive chunk.
  onOpen(item: Meta): void;
  onMenu?: MediaMenuHandler;
}) {
  const hold = useLongPress((x, y) => onMenu?.(item, x, y));
  const onClick = () => {
    if (!hold.consumedTap()) onOpen(item);
  };
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
      {...(onMenu ? hold : {})}
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
            <Eye size={15} />
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
  onMenu,
  subtitle,
}: {
  section: CatalogSection;
  index: WatchIndex;
  onOpen(item: Meta): void;
  onSeeAll?: () => void;
  onMenu?: MediaMenuHandler;
  subtitle?: string;
}) {
  const rowRef = useDragScroll<HTMLDivElement>();
  return (
    <section className="media-section">
      <header>
        <div>
          <h2>{section.name}</h2>
          {subtitle && <span>{subtitle}</span>}
        </div>
        {onSeeAll && <button onClick={onSeeAll}>See all</button>}
      </header>
      <div className="media-row" ref={rowRef}>
        {section.items.map((item) => (
          <PosterCard
            key={`${item.type}:${item.id}`}
            item={item}
            index={index}
            onOpen={onOpen}
            onMenu={onMenu}
          />
        ))}
      </div>
    </section>
  );
}

const HERO_ROTATE_MS = 9000;

/**
 * Rotating hero carousel.
 *
 * Nine seconds between slides, matching the desktop client. Rotation pauses
 * while the pointer is over it, so it cannot slide out from under a click, and
 * stops entirely for anyone who has asked for reduced motion.
 */
export function Hero({
  items,
  onOpen,
  onMenu,
}: {
  items: Meta[];
  onOpen(item: Meta): void;
  onMenu?: MediaMenuHandler;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState<
    "next" | "previous"
  >("next");
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const swipe = useRef({ active: false, pointerId: -1, x: 0, y: 0 });
  const active = items[index % Math.max(items.length, 1)];
  const hold = useLongPress((x, y) => {
    if (active) onMenu?.(active, x, y);
  });
  const move = (direction: -1 | 1) => {
    setTransitionDirection(direction > 0 ? "next" : "previous");
    setIndex((current) =>
      (current + direction + items.length) % items.length,
    );
  };

  const select = (nextIndex: number) => {
    if (nextIndex === index) return;
    setTransitionDirection(nextIndex > index ? "next" : "previous");
    setIndex(nextIndex);
  };

  useEffect(() => {
    if (index >= items.length) setIndex(0);
  }, [index, items.length]);

  useEffect(() => {
    if (items.length < 2 || paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => move(1), HERO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [items.length, paused, index]);

  if (!active) return null;
  const artwork = active.background || active.banner || active.poster;
  return (
    <section
      // Keyed so a slide change restarts the fade rather than cross-fading
      // two backgrounds into mud.
      key={`${active.type}:${active.id}`}
      className={`hero hero-transition-${transitionDirection}${dragging ? " is-dragging" : ""}`}
      {...(onMenu ? hold : {})}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => {
        if (!swipe.current.active) setPaused(false);
      }}
      onPointerDown={(event) => {
        if (items.length < 2 || (event.target as HTMLElement).closest("button"))
          return;
        swipe.current = {
          active: true,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPaused(true);
      }}
      onPointerMove={(event) => {
        const start = swipe.current;
        if (!start.active || start.pointerId !== event.pointerId) return;
        const x = event.clientX - start.x;
        const y = event.clientY - start.y;
        if (!dragging && Math.abs(x) < 7) return;
        if (!dragging && Math.abs(x) <= Math.abs(y)) return;
        setDragging(true);
        setDragX(Math.max(-170, Math.min(170, x)));
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        if (!start.active || start.pointerId !== event.pointerId) return;
        swipe.current.active = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        const x = event.clientX - start.x;
        const y = event.clientY - start.y;
        setDragging(false);
        setDragX(0);
        if (Math.abs(x) >= 48 && Math.abs(x) > Math.abs(y) * 1.15)
          move(x < 0 ? 1 : -1);
        setPaused(false);
      }}
      onPointerCancel={(event) => {
        if (swipe.current.pointerId !== event.pointerId) return;
        swipe.current.active = false;
        setDragging(false);
        setDragX(0);
        setPaused(false);
      }}
      style={
        {
          ...(artwork
            ? {
                backgroundImage: `linear-gradient(90deg, rgba(5,7,9,.98) 0%, rgba(5,7,9,.67) 46%, rgba(5,7,9,.12) 100%), linear-gradient(0deg, #080a0d 0%, transparent 55%), url("${artwork.replace(/"/g, "%22")}")`,
              }
            : {}),
          "--hero-drag-x": `${dragX}px`,
          "--hero-drag-opacity": Math.max(0.62, 1 - Math.abs(dragX) / 430),
        } as CSSProperties
      }
    >
      <div className="hero-copy">
        {active.logo ? (
          <img src={active.logo} className="title-logo" alt={active.name} />
        ) : (
          <h1>{active.name}</h1>
        )}
        <div className="hero-meta home-hero-meta">
          <span>{active.type === "series" ? "Series" : "Movie"}</span>
          {active.genres[0] && <span>{active.genres[0]}</span>}
          {active.releaseInfo && <span>{active.releaseInfo}</span>}
        </div>
        <button className="primary" onClick={() => onOpen(active)}>
          <Play size={18} fill="currentColor" /> View details
        </button>
      </div>
      {items.length > 1 && (
        <div className="hero-dots" role="tablist" aria-label="Featured titles">
          {items.map((item, dot) => (
            <button
              key={`${item.type}:${item.id}`}
              role="tab"
              aria-selected={dot === index}
              aria-label={item.name}
              className={dot === index ? "active" : undefined}
              onClick={() => select(dot)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
