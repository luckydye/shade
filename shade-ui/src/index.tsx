import { render } from "solid-js/web";
import App from "./App";
import {
  browserThumbnailBackend,
  setThumbnailBackend,
  tauriThumbnailBackend,
} from "./bridge/thumbnail-backend";

async function init() {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (isTauri()) {
    if (/\bMac\b/i.test(navigator.userAgent)) {
      document.documentElement.dataset.tauriMacos = "true";
    }
    setThumbnailBackend(tauriThumbnailBackend);
  } else {
    setThumbnailBackend(browserThumbnailBackend);
  }
  render(() => <App />, document.getElementById("root")!);
}

void init();
