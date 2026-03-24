import { render } from "solid-js/web";
import App from "./App";
import {
  browserThumbnailBackend,
  setThumbnailBackend,
  tauriThumbnailBackend,
} from "./bridge/thumbnail-backend";

async function init() {
  const { isTauri } = await import("@tauri-apps/api/core");
  setThumbnailBackend(isTauri() ? tauriThumbnailBackend : browserThumbnailBackend);
  render(() => <App />, document.getElementById("root")!);
}

void init();
