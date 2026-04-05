import { createShadeWorker } from "shade-wasm";
import type { BrowserPlatform } from "shade-ui/src/bridge/index";
import { browserCollectionsPlatform } from "./browser-collections-platform";
import { browserMediaPlatform } from "./browser-media-platform";
import { browserPresetsPlatform } from "./browser-presets-platform";
import { browserSnapshotsPlatform } from "./browser-snapshots-platform";
import { browserThumbnailBackend } from "./browser-thumbnail-backend";

export const browserPlatform: BrowserPlatform = {
  kind: "browser",
  thumbnailBackend: browserThumbnailBackend,
  collections: browserCollectionsPlatform,
  createWorker: createShadeWorker,
  media: browserMediaPlatform,
  presets: browserPresetsPlatform,
  snapshots: browserSnapshotsPlatform,
};
