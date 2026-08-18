import { execSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/** Short commit, or "unknown" where git is not available (a CI tarball). */
function commit() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // A GitHub project site is served from /<repo>/, not the domain root. The
  // workflow sets this; everything else (custom domain, local preview) stays
  // at "/" and is unaffected.
  const base = env.VITE_BASE_PATH || "/";
  return {
    base,
    define: {
      // Changes every build, so Settings can show which one is running — the
      // quickest way to confirm an update actually applied. The commit is in
      // there too, so a report from a phone names the code it came from.
      __APP_BUILD__: JSON.stringify(
        `${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${commit()}`,
      ),
      "import.meta.env.VITE_NUVIO_SUPABASE_URL": JSON.stringify(env.VITE_NUVIO_SUPABASE_URL || env.NUVIO_SUPABASE_URL || ""),
      "import.meta.env.VITE_NUVIO_SUPABASE_FALLBACK_URL": JSON.stringify(env.VITE_NUVIO_SUPABASE_FALLBACK_URL || env.NUVIO_SUPABASE_FALLBACK_URL || ""),
      "import.meta.env.VITE_NUVIO_SUPABASE_ANON_KEY": JSON.stringify(env.VITE_NUVIO_SUPABASE_ANON_KEY || env.NUVIO_SUPABASE_ANON_KEY || ""),
      // Episode scores come from the same service the official clients use;
      // the URL is a secret there too, so it stays out of the repo.
      "import.meta.env.VITE_IMDB_RATINGS_BASE_URL": JSON.stringify(env.VITE_IMDB_RATINGS_BASE_URL || env.IMDB_TAPFRAME_API_BASE_URL || ""),
      "import.meta.env.VITE_IMDB_RATINGS_FALLBACK_URL": JSON.stringify(env.VITE_IMDB_RATINGS_FALLBACK_URL || env.IMDB_RATINGS_API_BASE_URL || ""),
    },
    plugins: [
      react(),
      VitePWA({
        // "prompt", not "autoUpdate": autoUpdate reloads the page as soon as a
        // new worker takes control, which restarted the app mid-boot.
        registerType: "prompt",
        includeAssets: [
          "app-icon-1024.png",
          "Nuvio-icon.png",
          "nuvio-wordmark.png",
        ],
        manifest: {
          name: "Nuvio Web",
          short_name: "Nuvio",
          description: "Browse Nuvio catalogs and play browser-compatible streams.",
          theme_color: "#080a0d",
          background_color: "#080a0d",
          display: "standalone",
          orientation: "any",
          start_url: base,
          scope: base,
          icons: [
            { src: `${base}app-icon-1024.png`, sizes: "1024x1024", type: "image/png", purpose: "any" },
            // Kept separate from "any": a maskable icon is cropped to the
            // platform's safe zone, so declaring one entry as both lets
            // Android crop artwork that was never padded for it.
            { src: `${base}app-icon-1024.png`, sizes: "1024x1024", type: "image/png", purpose: "maskable" }
          ]
        },
        workbox: {
          navigateFallback: `${base}index.html`,
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.destination === "image",
              handler: "CacheFirst",
              options: { cacheName: "nuvio-images", expiration: { maxEntries: 300, maxAgeSeconds: 604800 } }
            }
          ]
        }
      })
    ],
    // The tunnel forwards the public Host header through to Vite, which
    // rejects hosts it does not know with "Blocked request".
    server: { port: 4174, host: "0.0.0.0", allowedHosts: ["nuvioweb.lucaboox.win"] },
    // The tunnel targets preview, not dev: vite-plugin-pwa only emits a
    // service worker on build, so a PWA install needs the built output.
    // strictPort keeps it from drifting onto another port and silently
    // leaving the tunnel pointed at nothing.
    preview: { port: 4180, strictPort: true, host: "0.0.0.0", allowedHosts: ["nuvioweb.lucaboox.win"] }
  };
});
