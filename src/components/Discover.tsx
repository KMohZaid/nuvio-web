import { useCallback, useEffect, useMemo, useState } from "react";
import {
  discoverCatalogs,
  loadDiscoverCatalog,
  type DiscoverCatalog,
} from "../lib/addons";
import type { WatchIndex } from "../lib/progress";
import { useProgressiveList } from "../lib/useProgressiveList";
import type { InstalledAddon, Meta } from "../types";
import { PosterCard } from "./Media";

const ALL_GENRES = "__all__";

const typeLabel = (value: string) =>
  value === "movie"
    ? "Movies"
    : value === "series"
      ? "Series"
      : value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Browses addon catalogs without a search term, matching the desktop client:
 * a type picker, the catalogs serving that type, and the genres that catalog's
 * manifest advertises.
 */
export function Discover({
  addons,
  index,
  query,
  results,
  onOpen,
}: {
  addons: InstalledAddon[];
  index: WatchIndex;
  query: string;
  results: Meta[];
  onOpen(item: Meta): void;
}) {
  const catalogs = useMemo(() => discoverCatalogs(addons), [addons]);
  const [type, setType] = useState<string | null>(null);
  const [catalogKey, setCatalogKey] = useState<string | null>(null);
  const [genre, setGenre] = useState(ALL_GENRES);
  const [items, setItems] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const types = useMemo(
    // Set preserves first-seen order, which is addon priority then manifest
    // order. Sorting here would disagree with the addon configuration.
    () => [...new Set(catalogs.map((item) => item.contentType))],
    [catalogs],
  );
  const activeType = type ?? types[0] ?? null;
  const typeCatalogs = useMemo(
    () => catalogs.filter((item) => item.contentType === activeType),
    [catalogs, activeType],
  );
  const catalog: DiscoverCatalog | undefined =
    typeCatalogs.find((item) => item.key === catalogKey) ?? typeCatalogs[0];

  // A required genre falls back to the first option, an optional one to "all".
  const effectiveGenre = useMemo(() => {
    if (!catalog || catalog.genreOptions.length === 0) return undefined;
    if (genre !== ALL_GENRES && catalog.genreOptions.includes(genre))
      return genre;
    return catalog.genreRequired ? catalog.genreOptions[0] : undefined;
  }, [catalog, genre]);

  const load = useCallback(async () => {
    if (!catalog) return;
    setLoading(true);
    setError("");
    setItems([]);
    try {
      setItems(await loadDiscoverCatalog(catalog, effectiveGenre));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load catalog",
      );
    } finally {
      setLoading(false);
    }
  }, [catalog, effectiveGenre]);

  useEffect(() => {
    load();
  }, [load]);

  const searching = query.trim().length > 0;
  const shown = searching ? results : items;
  const { visible } = useProgressiveList(shown);

  return (
    <section className="grid-page">
      <span className="eyebrow">NUVIO WEB</span>
      <h1>{searching ? `Results for “${query}”` : "Discover"}</h1>
      <p>
        {searching
          ? `${results.length} titles from searchable addon catalogs`
          : `${catalog?.addonName ?? "No addon"} · browse installed catalogs`}
      </p>

      {!searching && (
        <div className="discover-filters">
          <label>
            <span>Type</span>
            <select
              value={activeType ?? ""}
              onChange={(event) => {
                setType(event.target.value);
                setCatalogKey(null);
                setGenre(ALL_GENRES);
              }}
            >
              {types.map((option) => (
                <option key={option} value={option}>
                  {typeLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Catalog</span>
            <select
              value={catalog?.key ?? ""}
              onChange={(event) => {
                setCatalogKey(event.target.value);
                setGenre(ALL_GENRES);
              }}
            >
              {typeCatalogs.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.catalogName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Genre</span>
            <select
              value={effectiveGenre ?? ALL_GENRES}
              disabled={!catalog || catalog.genreOptions.length === 0}
              onChange={(event) => setGenre(event.target.value)}
            >
              {catalog && !catalog.genreRequired && (
                <option value={ALL_GENRES}>All genres</option>
              )}
              {catalog?.genreOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {catalog?.genreOptions.length === 0 && (
                <option value={ALL_GENRES}>Not supported</option>
              )}
            </select>
          </label>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {!loading && shown.length === 0 && !error ? (
        <div className="empty-state">
          <strong>Nothing returned</strong>
          <span>
            {searching
              ? "No addon matched that search."
              : "This catalog produced no titles for that filter."}
          </span>
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
    </section>
  );
}
