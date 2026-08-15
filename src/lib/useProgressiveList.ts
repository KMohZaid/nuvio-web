import { useEffect, useState } from "react";

/**
 * Renders a long list in growing slices so a tab switch paints immediately.
 *
 * The catalog pages hold hundreds of poster cards. Committing them all in the
 * click handler's render blocks paint for as long as it takes, which is what
 * made the nav feel like it was loading something — the data was already in
 * memory, React was just busy building DOM. Showing a first screenful and
 * growing on subsequent frames keeps the tab switch instant.
 */
const FIRST_PAINT = 36;
const CHUNK = 60;

export function useProgressiveList<T>(items: T[]): {
  visible: T[];
  complete: boolean;
} {
  const [limit, setLimit] = useState(FIRST_PAINT);

  // Any new list starts over, so switching tabs never inherits a large limit
  // and pays the full cost up front again.
  useEffect(() => {
    setLimit(FIRST_PAINT);
  }, [items]);

  useEffect(() => {
    if (limit >= items.length) return;
    // rAF rather than a timer: this yields to paint but still fills the list
    // within a few frames, so a scroll never outruns it.
    const handle = requestAnimationFrame(() =>
      setLimit((current) => current + CHUNK),
    );
    return () => cancelAnimationFrame(handle);
  }, [limit, items.length]);

  return {
    visible: limit >= items.length ? items : items.slice(0, limit),
    complete: limit >= items.length,
  };
}
