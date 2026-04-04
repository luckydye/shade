import type { TauriPlatform } from "shade-ui/src/bridge/index";
import { tauriPlatform } from "./tauri-platform";
import { tauriThumbnailBackend } from "./tauri-thumbnail-backend";

export const platform: TauriPlatform = {
  ...tauriPlatform,
  kind: "tauri",
  thumbnailBackend: tauriThumbnailBackend,
};
