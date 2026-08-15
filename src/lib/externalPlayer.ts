import type { ExternalPlayerMode } from "../types";

export function launchExternalPlayer(
  mode: ExternalPlayerMode,
  url: string,
  title: string,
) {
  if (!/^https?:\/\//i.test(url)) {
    window.location.href = url;
    return;
  }
  if (mode === "vlc")
    window.location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
  else if (mode === "outplayer") window.location.href = `outplayer://${url}`;
  else if (mode === "m3u") {
    const blob = new Blob(
      [`#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n,]/g, " ")}\n${url}\n`],
      { type: "audio/x-mpegurl" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${title.replace(/[^a-z0-9 _.-]/gi, "_") || "Nuvio"}.m3u`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }
}
