import { useEffect } from "react";

/**
 * Freezes the page behind a full-screen overlay.
 *
 * The detail view is `position: fixed` with its own scroller, so without this
 * the document keeps its scrollbar too — two scrollbars on desktop, and the
 * background scrolls when the overlay reaches its end.
 *
 * Ref-counted so overlapping overlays cannot unlock while one is still open.
 */
let depth = 0;

export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    depth += 1;
    document.body.classList.add("is-locked");
    return () => {
      depth -= 1;
      if (depth === 0) document.body.classList.remove("is-locked");
    };
  }, [active]);
}
