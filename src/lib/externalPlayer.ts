import type { ExternalPlayerMode } from "../types";
import { safeHttpUrl } from "./security.ts";

export const isAppleMobile = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac, so the touch count is the giveaway.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isAndroid = () => /Android/i.test(navigator.userAgent);

export const isMacOS = () =>
  !isAppleMobile() && /Macintosh|Mac OS X/i.test(navigator.userAgent);

export const isDesktop = () => !isAppleMobile() && !isAndroid();

export type ExternalPlayerSurface = "settings" | "player";
type PlayerPlatform = "android" | "apple-mobile" | "macos" | "desktop";

type ExternalPlayerDefinition = {
  mode: ExternalPlayerMode;
  label: string | Partial<Record<PlayerPlatform, string>>;
  platforms: Record<ExternalPlayerSurface, readonly PlayerPlatform[]>;
};

const externalPlayerDefinitions: readonly ExternalPlayerDefinition[] = [
  {
    mode: "copy",
    label: "Copy stream URL",
    platforms: { settings: ["macos", "desktop"], player: ["android", "apple-mobile", "macos", "desktop"] },
  },
  {
    mode: "vlc",
    label: "VLC",
    platforms: { settings: ["android", "apple-mobile", "macos"], player: ["android", "apple-mobile", "macos"] },
  },
  {
    mode: "nextplayer",
    label: "Next Player",
    platforms: { settings: ["android"], player: ["android"] },
  },
  {
    mode: "mxplayer",
    label: "MX Player",
    platforms: { settings: ["android"], player: ["android"] },
  },
  {
    mode: "mpv",
    label: { android: "mpv", macos: "mpv (mpv-handler plugin required)", desktop: "mpv (mpv-handler plugin required)" },
    platforms: { settings: ["android", "macos", "desktop"], player: ["android", "macos", "desktop"] },
  },
  {
    mode: "android-chooser",
    label: "Android video player chooser",
    platforms: { settings: ["android"], player: ["android"] },
  },
  {
    mode: "outplayer",
    label: "Outplayer",
    platforms: { settings: ["apple-mobile", "macos"], player: ["apple-mobile", "macos"] },
  },
  {
    mode: "infuse",
    label: "Infuse",
    platforms: { settings: ["apple-mobile", "macos"], player: ["apple-mobile", "macos"] },
  },
  {
    mode: "iina",
    label: "IINA",
    platforms: { settings: ["macos"], player: ["macos"] },
  },
  {
    mode: "m3u",
    label: "Download M3U playlist",
    platforms: { settings: ["android", "apple-mobile", "macos", "desktop"], player: ["android", "apple-mobile", "macos", "desktop"] },
  },
];

function playerPlatform(): PlayerPlatform {
  if (isAndroid()) return "android";
  if (isAppleMobile()) return "apple-mobile";
  if (isMacOS()) return "macos";
  return "desktop";
}

export function externalPlayerOptions(surface: ExternalPlayerSurface) {
  const platform = playerPlatform();
  return externalPlayerDefinitions
    .filter((option) => option.platforms[surface].includes(platform))
    .map((option) => ({
      mode: option.mode,
      label:
        typeof option.label === "string"
          ? option.label
          : option.label[platform] ?? "mpv",
    }));
}

export function externalPlayerLabel(mode: ExternalPlayerMode) {
  return (
    externalPlayerOptions("player").find((option) => option.mode === mode)
      ?.label ?? "Nuvio web player"
  );
}

export const isExternalPlayerAvailable = (mode: ExternalPlayerMode) =>
  mode === "internal" ||
  externalPlayerOptions("settings").some((option) => option.mode === mode);

function m3uFor(url: string, title: string) {
  return new Blob(
    [`#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n,]/g, " ")}\n${url}\n`],
    { type: "audio/x-mpegurl" },
  );
}

function download(blob: Blob, title: string, extension: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/[^a-z0-9 _.-]/gi, "_") || "Nuvio"}.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

export async function copyStreamUrl(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // Clipboard access can be refused even on HTTPS if the click is not
    // treated as a gesture. Fall back to a selectable prompt.
    window.prompt("Copy this stream URL", url);
    return false;
  }
}

export function infusePlaybackUrl(url: string, title: string) {
  let extension = ".mkv";
  try {
    const match = new URL(url).pathname.match(/\.(mkv|mp4|m4v|mov|avi|webm)$/i);
    if (match) extension = match[0].toLowerCase();
  } catch {
    // Signed and custom URLs do not always parse, but filename is optional.
  }
  const filename = `${title.replace(/[^a-z0-9 _.-]/gi, "_").trim() || "Nuvio"}${extension}`;
  const query = new URLSearchParams({ url, filename });
  return `infuse://x-callback-url/play?${query.toString()}`;
}

export function androidIntentUrl(
  url: string,
  title: string,
  packageName?: string,
) {
  const parsed = new URL(url);
  const packagePart = packageName ? `package=${packageName};` : "";
  return `intent://${parsed.host}${parsed.pathname}${parsed.search}#Intent;scheme=${parsed.protocol.slice(0, -1)};${packagePart}action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(title)};end`;
}

export function mpvHandlerUrl(url: string) {
  return `mpv-handler://play/${btoa(url)}`;
}

/** Hands a stream to a registered player outside the browser. */
export function launchExternalPlayer(
  mode: ExternalPlayerMode,
  url: string,
  title: string,
) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) {
    // Never navigate to an addon-supplied custom scheme (especially
    // javascript:). Copying keeps unusual sources usable without executing
    // them in the PWA origin.
    void copyStreamUrl(url);
    return;
  }
  if (mode === "copy") {
    void copyStreamUrl(safeUrl);
    return;
  }
  if (mode === "vlc" && isAndroid()) {
    window.location.href = androidIntentUrl(safeUrl, title, "org.videolan.vlc");
    return;
  }
  if (mode === "nextplayer") {
    window.location.href = androidIntentUrl(
      safeUrl,
      title,
      "dev.anilbeesetti.nextplayer",
    );
    return;
  }
  if (mode === "mxplayer") {
    window.location.href = androidIntentUrl(
      safeUrl,
      title,
      "com.mxtech.videoplayer.ad",
    );
    return;
  }
  if (mode === "mpv" && isAndroid()) {
    window.location.href = androidIntentUrl(safeUrl, title, "is.xyz.mpv");
    return;
  }
  if (mode === "android-chooser") {
    window.location.href = androidIntentUrl(safeUrl, title);
    return;
  }
  if (mode === "vlc") {
    window.location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(safeUrl)}`;
    return;
  }
  if (mode === "outplayer") {
    window.location.href = `outplayer://${safeUrl}`;
    return;
  }
  if (mode === "infuse") {
    window.location.href = infusePlaybackUrl(safeUrl, title);
    return;
  }
  if (mode === "iina") {
    window.location.href = `iina://weblink?url=${encodeURIComponent(safeUrl)}`;
    return;
  }
  if (mode === "mpv") {
    window.location.href = mpvHandlerUrl(safeUrl);
    return;
  }
  if (mode === "m3u") download(m3uFor(safeUrl, title), title, "m3u");
}
