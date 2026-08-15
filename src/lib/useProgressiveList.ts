import { useEffect, useState } from "react";

/**
 * Renders a long list in growing slices so a view paints immediately.
 *
 * Committing several hundred cards inside a click handler blocks paint for as
 * long as it takes, which reads as the app loading something when the data is
 * already in memory. Showing a first screenful and growing on later frames
 * keeps the switch instant.
 *
 * `resetKey` is what identifies "a different list". It must not be the array
 * itself: appending a page of results produces a new array, and resetting on
 * that collapsed the grid back to one screenful mid-scroll, which yanked the
 * scroll position every time a page loaded.
 */
export function useProgressiveList<T>(
  items: T[],
  options: { resetKey?: unknown; first?: number; chunk?: number } = {},
): { visible: T[]; complete: boolean } {
  const { resetKey, first = 36, chunk = 60 } = options;
  const [limit, setLimit] = useState(first);

  useEffect(() => {
    setLimit(first);
  }, [resetKey, first]);

  useEffect(() => {
    if (limit >= items.length) return;
    // rAF rather than a timer: yields to paint but still fills within a few
    // frames, so scrolling never outruns it.
    const handle = requestAnimationFrame(() =>
      setLimit((current) => current + chunk),
    );
    return () => cancelAnimationFrame(handle);
  }, [limit, items.length, chunk]);

  return {
    visible: limit >= items.length ? items : items.slice(0, limit),
    complete: limit >= items.length,
  };
}
