import { render } from "solid-js/web";
import App from "./App";
import { setThumbnailBackend, tauriThumbnailBackend } from "./bridge/thumbnail-backend";

async function init() {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (isTauri()) {
    if (/\bMac\b/i.test(navigator.userAgent)) {
      document.documentElement.dataset.tauriMacos = "true";
    }
    setThumbnailBackend(tauriThumbnailBackend);
  } else {
    throw new Error("browser runtime is only supported via shade-web");
  }
  render(() => <App />, document.getElementById("root")!);
}

void init();
