import type { BrowserPlatform } from "shade-ui/src/bridge/index";
import { browserCollectionsPlatform } from "./browser-collections-platform";
import { browserLibraryCache } from "./browser-library-cache";
import { browserMediaPlatform } from "./browser-media-platform";
import { browserRatingsPlatform } from "./browser-ratings-platform";
import { browserPresetsPlatform } from "./browser-presets-platform";
import { browserSnapshotsPlatform } from "./browser-snapshots-platform";
import { browserThumbnailBackend } from "./browser-thumbnail-backend";
import { getSharedWorker } from "./shared-worker";

export const browserPlatform: BrowserPlatform = {
  kind: "browser",
  thumbnailBackend: browserThumbnailBackend,
  libraryCache: browserLibraryCache,
  collections: browserCollectionsPlatform,
  // The bridge's legacy workerCall path expects a Worker. It gets the same
  // shared instance the unified Transport uses so wasm state is consistent.
  createWorker: () => getSharedWorker(),
  media: browserMediaPlatform,
  presets: browserPresetsPlatform,
  snapshots: browserSnapshotsPlatform,
  ratings: browserRatingsPlatform,
};
