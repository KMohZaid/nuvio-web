import { useRef } from "react";

/**
 * Opens a context menu from either a right-click or a touch hold.
 *
 * Touch and mouse are handled separately on purpose: `contextmenu` does fire
 * on a long press on Android, but not on iOS, and using pointer events for
 * both would swallow ordinary taps. The touch path cancels itself if the
 * finger travels, so scrolling a list never triggers it.
 */
const HOLD_MS = 450;
const MOVE_TOLERANCE_PX = 12;

export function useLongPress(onOpen: (x: number, y: number) => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  return {
    onContextMenu(event: React.MouseEvent) {
      event.preventDefault();
      onOpen(event.clientX, event.clientY);
    },
    onTouchStart(event: React.TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      fired.current = false;
      origin.current = { x: touch.clientX, y: touch.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onOpen(touch.clientX, touch.clientY);
      }, HOLD_MS);
    },
    onTouchMove(event: React.TouchEvent) {
      const touch = event.touches[0];
      const start = origin.current;
      if (!touch || !start) return;
      const travelled =
        Math.abs(touch.clientX - start.x) + Math.abs(touch.clientY - start.y);
      if (travelled > MOVE_TOLERANCE_PX) cancel();
    },
    onTouchEnd(event: React.TouchEvent) {
      // The hold already acted; stop the tap from also opening the episode.
      if (fired.current) event.preventDefault();
      cancel();
    },
    onTouchCancel: cancel,
    /** True when the last touch ended as a hold rather than a tap. */
    consumedTap: () => fired.current,
  };
}
