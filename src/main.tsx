import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { setRegistration, setUpdateHandler } from "./lib/appUpdate";
import { lockZoom } from "./lib/lockZoom";
import "./styles.css";

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // Kept so Settings can trigger an update check on demand.
    setRegistration(registration ?? null);
  },
  onNeedRefresh() {
    // Held until the user asks for it, so a deploy never interrupts playback.
    setUpdateHandler(async () => {
      await updateSW(true);
    });
  },
});
lockZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

