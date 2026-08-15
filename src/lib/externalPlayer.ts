import type { ExternalPlayerMode } from "../types";

export const isAppleMobile = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac, so the touch count is the giveaway.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isDesktop = () =>
  !isAppleMobile() && !/Android/i.test(navigator.userAgent);

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

/**
 * Hands a stream to something outside the browser.
 *
 * Desktop has no reliable route: VLC registers no URL scheme on Windows, and
 * a downloaded playlist opens in whatever claims the extension — iTunes, in
 * practice. So desktop copies the URL and lets the user paste it. iOS is the
 * one platform where a real registered scheme exists.
 */
export function launchExternalPlayer(
  mode: ExternalPlayerMode,
  url: string,
  title: string,
) {
  if (!/^https?:\/\//i.test(url)) {
    window.location.href = url;
    return;
  }
  if (mode === "copy") {
    void copyStreamUrl(url);
    return;
  }
  if (mode === "vlc") {
    window.location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
    return;
  }
  if (mode === "outplayer") {
    window.location.href = `outplayer://${url}`;
    return;
  }
  if (mode === "m3u") download(m3uFor(url, title), title, "m3u");
}
