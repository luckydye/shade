import type { TauriPlatform } from "shade-ui/src/bridge/index";
import { tauriCollectionsPlatform } from "./tauri-collections-platform";
import { tauriLibraryCache } from "./tauri-library-cache";
import { tauriPlatform } from "./tauri-platform";
import { tauriThumbnailBackend } from "./tauri-thumbnail-backend";

export const platform: TauriPlatform = {
  ...tauriPlatform,
  kind: "tauri",
  thumbnailBackend: tauriThumbnailBackend,
  libraryCache: tauriLibraryCache,
  collections: tauriCollectionsPlatform,
};
