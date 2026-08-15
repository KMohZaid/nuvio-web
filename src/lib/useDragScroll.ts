import { useEffect, useRef } from "react";

/**
 * Click-and-drag horizontal scrolling for the carousels.
 *
 * A touch device already pans these natively, so this binds mouse input only —
 * hijacking touch would break that. The drag has to out-travel a threshold
 * before it takes over, otherwise every click on a poster would be swallowed
 * by a one-pixel movement between press and release.
 */
const DRAG_THRESHOLD_PX = 6;

export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;

    const onPointerDown = (event: PointerEvent) => {
      // Primary button only, and never on a real control the row may contain.
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startScroll = node.scrollLeft;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const delta = event.clientX - startX;
      if (!moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        node.classList.add("is-dragging");
        // Claim the pointer so leaving the row mid-drag does not strand it.
        node.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      node.scrollLeft = startScroll - delta;
    };

    const finish = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      node.classList.remove("is-dragging");
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId);
    };

    // A drag that ends over a poster must not also open it. Capture phase, so
    // this runs before the card's own handler.
    const onClickCapture = (event: MouseEvent) => {
      if (!moved) return;
      moved = false;
      event.preventDefault();
      event.stopPropagation();
    };

    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", finish);
    node.addEventListener("pointercancel", finish);
    node.addEventListener("click", onClickCapture, { capture: true });
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", finish);
      node.removeEventListener("pointercancel", finish);
      node.removeEventListener("click", onClickCapture, { capture: true });
    };
  }, []);

  return ref;
}
