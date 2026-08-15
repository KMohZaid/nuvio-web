import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeCollectionSources,
  loadCollectionSources,
} from "../lib/addons";
import type { WatchIndex } from "../lib/progress";
import { useProgressiveList } from "../lib/useProgressiveList";
import type {
  Collection,
  CollectionFolder,
  InstalledAddon,
  Meta,
} from "../types";
import { PosterCard } from "./Media";

/**
 * Nuvio's tile shapes. The default is `poster`, not landscape — a folder with
 * no explicit shape is a 2:3 tile like every other card on the page.
 */
function normalizedShape(shape?: string): "poster" | "landscape" | "square" {
  const value = (shape ?? "").toLowerCase();
  if (value === "landscape" || value === "wide") return "landscape";
  if (value === "square") return "square";
  return "poster";
}

/** A collection as a row of folder tiles, the way Nuvio shows them on home. */
export function CollectionRow({
  collection,
  onOpenFolder,
}: {
  collection: Collection;
  onOpenFolder(folder: CollectionFolder): void;
}) {
  if (collection.folders.length === 0) return null;
  return (
    <section className="media-section">
      <header>
        <div>
          <h2>{collection.title}</h2>
          <span>Collection</span>
        </div>
      </header>
      <div className="media-row folder-row">
        {collection.folders.map((folder) => (
          <button
            key={folder.id}
            className={`folder-tile shape-${normalizedShape(folder.tileShape)}`}
            onClick={() => onOpenFolder(folder)}
          >
            <span className="folder-art">
              {folder.coverImageUrl ? (
                <img src={folder.coverImageUrl} alt="" loading="lazy" />
              ) : (
                <span className="folder-emoji">{folder.coverEmoji || "★"}</span>
              )}
            </span>
            {!folder.hideTitle && <strong>{folder.title}</strong>}
            <small>
              {folder.catalogSources.length} catalog
              {folder.catalogSources.length === 1 ? "" : "s"}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

const ALL_SOURCES = "__all__";
const PAGE_SIZE_GUESS = 20;

/**
 * One folder, with a picker for the catalogs inside it.
 *
 * Nuvio's own default view mode for a collection is TABBED_GRID — one tab per
 * source over a shared grid — so a picker is the native shape here, not
 * stacked rows. A dropdown rather than tabs keeps it usable on a phone and
 * matches the Discover filters.
 */
export function CollectionFolderView({
  folder,
  addons,
  index,
  onBack,
  onOpen,
}: {
  folder: CollectionFolder;
  addons: InstalledAddon[];
  index: WatchIndex;
  onBack(): void;
  onOpen(item: Meta): void;
}) {
  const sources = useMemo(
    () => describeCollectionSources(folder, addons),
    [folder, addons],
  );
  const [selected, setSelected] = useState(ALL_SOURCES);
  const [items, setItems] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement | null>(null);

  const active = useMemo(
    () =>
      selected === ALL_SOURCES
        ? sources.map((entry) => entry.source)
        : sources
            .filter((entry) => entry.key === selected)
            .map((entry) => entry.source),
    [selected, sources],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    setExhausted(false);
    setItems([]);
    loadCollectionSources(active, addons, 0)
      .then((result) => {
        if (!live) return;
        setItems(result.items);
        if (result.items.length === 0) {
          setExhausted(true);
          if (result.errors.length) setError(result.errors[0]);
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [active, addons]);

  const more = useCallback(async () => {
    if (loading || loadingMore || exhausted || items.length === 0) return;
    setLoadingMore(true);
    try {
      // `skip` is per source. Merging several sources means `items.length`
      // overshoots any single one, so divide it back down or the next page
      // jumps past results.
      const skip =
        selected === ALL_SOURCES
          ? Math.ceil(
              items.length / Math.max(active.length, 1) / PAGE_SIZE_GUESS,
            ) * PAGE_SIZE_GUESS
          : items.length;
      const next = await loadCollectionSources(active, addons, skip);
      const known = new Set(items.map((item) => `${item.type}:${item.id}`));
      const additions = next.items.filter(
        (item) => !known.has(`${item.type}:${item.id}`),
      );
      // Addons that ignore `skip` return the same page forever, so a page that
      // adds nothing new ends the run rather than looping.
      if (additions.length === 0) setExhausted(true);
      else setItems((current) => [...current, ...additions]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load more",
      );
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, [active, addons, exhausted, items, loading, loadingMore, selected]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || exhausted) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, exhausted]);

  const { visible } = useProgressiveList(items, {
    resetKey: `${folder.id}:${selected}`,
  });

  return (
    <section className="grid-page">
      <div className="page-head">
        <button
          className="circle-button"
          aria-label="Back"
          title="Back"
          onClick={onBack}
        >
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">COLLECTION</span>
          <h1>{folder.title}</h1>
          <p>
            {loading
              ? "Loading catalogs…"
              : `${items.length} titles · ${sources.length} catalog${
                  sources.length === 1 ? "" : "s"
                }`}
          </p>
        </div>
      </div>

      {sources.length > 1 && (
        <div className="discover-filters">
          <label>
            <span>Catalog</span>
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value={ALL_SOURCES}>All catalogs</option>
              {sources.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <strong>Nothing returned</strong>
          <span>These catalogs produced no titles.</span>
        </div>
      ) : (
        <div className="poster-grid">
          {visible.map((item) => (
            <PosterCard
              key={`${item.type}:${item.id}`}
              item={item}
              index={index}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
      {!exhausted && <div ref={sentinel} className="grid-sentinel" />}
      {loadingMore && (
        <div className="grid-more" role="status">
          <i className="mini-spinner" />
          Loading more…
        </div>
      )}
    </section>
  );
}
