/**
 * Bridges the service-worker registration in main.tsx to the UI.
 *
 * `registerType: "autoUpdate"` called `location.reload()` the moment a new
 * worker took control. On any visit that found a new build that meant: boot,
 * paint the splash, reload, paint the splash again — the double "Restoring
 * Nuvio…". The update is now surfaced instead of applied mid-boot.
 */
type Listener = () => void;

let apply: (() => Promise<void>) | null = null;
let ready = false;
let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<Listener>();

export function setRegistration(value: ServiceWorkerRegistration | null): void {
  registration = value;
}

export type UpdateCheck = "pending" | "current" | "unsupported";

/**
 * Asks the browser to re-fetch the worker script now, rather than waiting for
 * its own periodic check. A pending worker means a new build is waiting, and
 * `onNeedRefresh` will have raised the reload prompt.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const active =
    registration ??
    (await navigator.serviceWorker?.getRegistration().catch(() => null)) ??
    null;
  if (!active) return "unsupported";
  registration = active;
  try {
    await active.update();
  } catch {
    return "unsupported";
  }
  return active.waiting || active.installing || ready ? "pending" : "current";
}

export function setUpdateHandler(handler: () => Promise<void>): void {
  apply = handler;
  ready = true;
  for (const listener of listeners) listener();
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const updateReady = () => ready;

/**
 * Activates the waiting worker and reloads.
 *
 * Driven directly rather than left to the plugin's helper: that helper is a
 * no-op when it cannot find a waiting worker, which left the Reload button
 * doing nothing at all. This posts SKIP_WAITING itself, reloads on
 * `controllerchange`, and force-reloads shortly after regardless — a reload is
 * always the correct outcome of pressing Reload.
 */
export async function applyUpdate(): Promise<void> {
  const reload = () => window.location.reload();
  try {
    const active =
      registration ??
      (await navigator.serviceWorker?.getRegistration().catch(() => null)) ??
      null;
    navigator.serviceWorker?.addEventListener("controllerchange", reload, {
      once: true,
    });
    active?.waiting?.postMessage({ type: "SKIP_WAITING" });
    await apply?.();
  } catch {
    // Ignored: the timer below still reloads.
  }
  window.setTimeout(reload, 1200);
}
