/**
 * Holds the page at 1x on touch devices.
 *
 * The viewport meta and `touch-action` in CSS cover Android and recent Safari,
 * but iOS still emits its non-standard `gesture*` events for a pinch and will
 * zoom on a double tap regardless of `user-scalable=no`. Both have to be
 * cancelled explicitly, and the listeners must be passive: false or
 * preventDefault is ignored.
 */
export function lockZoom(): void {
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }

  // Double-tap zoom is already handled by `touch-action` in CSS. Cancelling
  // it here as well would suppress the click that follows any second tap
  // inside the window, which made rapid taps on the nav do nothing.

  // A two-finger drag is the other way into a pinch on iOS.
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
}
