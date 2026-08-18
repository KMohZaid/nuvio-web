import { CLIENT_ID, rpc } from "./account";

/**
 * Registers this browser as a device on the account.
 *
 * A port of `DeviceSessionRegistration` from the official client: the same
 * `register_current_device` RPC, the same five parameters, the same fifteen
 * minute interval between registrations, and the same installation id the sync
 * writes are stamped with. Without it a browser signed into an account is
 * invisible in the device list and so cannot be revoked from it — every other
 * client is listed there, and this one simply was not.
 */

const REGISTRATION_INTERVAL_MS = 15 * 60 * 1000;

let lastRegistration = 0;
let inFlight: Promise<boolean> | null = null;

type DeviceClientMetadata = {
  clientName: string;
  deviceName: string;
  platform: string;
};

/**
 * What to call this browser in the list.
 *
 * The other clients have a real device name to give — a hostname, a phone's
 * name. A browser has none, and asking for one would be worse than deriving
 * something recognisable, so this reads "Safari on iPhone": enough to pick your
 * own entry out of a list, and nothing that is not already in the request
 * headers of every page you load.
 */
function currentDeviceClientMetadata(): DeviceClientMetadata {
  const agent = navigator.userAgent;
  const browser =
    /Firefox\/\d/.test(agent) ? "Firefox"
    : /Edg\/\d/.test(agent) ? "Edge"
    : /OPR\/\d/.test(agent) ? "Opera"
    : /Chrome\/\d/.test(agent) && !/Chromium/.test(agent) ? "Chrome"
    : /Safari\/\d/.test(agent) ? "Safari"
    : "Browser";

  const system =
    /iPhone/.test(agent) ? "iPhone"
    : /iPad/.test(agent) ? "iPad"
    : /Android/.test(agent) ? "Android"
    : /Macintosh|Mac OS X/.test(agent) ? "Mac"
    : /Windows/.test(agent) ? "Windows"
    : /Linux/.test(agent) ? "Linux"
    : "";

  // An installed web app is its own entry in the list, and worth telling apart
  // from the same browser on the same device.
  const installed =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;

  const version = /(?:iPhone |CPU )OS (\d+)[_.]/.exec(agent)?.[1]
    ?? /Android (\d+)/.exec(agent)?.[1]
    ?? "";

  return {
    clientName: installed ? "Nuvio Web (installed)" : "Nuvio Web",
    deviceName: system ? `${browser} on ${system}` : browser,
    platform: [system || "Web", version].filter(Boolean).join(" "),
  };
}

/**
 * Registers, unless it was done recently.
 *
 * Failure is deliberately quiet and returns false: this is bookkeeping, and a
 * device list that missed an update is not a reason to interrupt anyone.
 */
export async function registerCurrentDevice(force = false): Promise<boolean> {
  if (!force && Date.now() - lastRegistration < REGISTRATION_INTERVAL_MS)
    return true;
  if (inFlight) return inFlight;

  const metadata = currentDeviceClientMetadata();
  inFlight = rpc("register_current_device", {
    p_installation_id: CLIENT_ID,
    p_client_name: metadata.clientName,
    p_client_version: __APP_VERSION__,
    p_platform: metadata.platform,
    p_device_name: metadata.deviceName,
  })
    .then(() => {
      lastRegistration = Date.now();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** A new sign-in is a new session, whatever was registered before it. */
export function resetDeviceRegistration() {
  lastRegistration = 0;
}
