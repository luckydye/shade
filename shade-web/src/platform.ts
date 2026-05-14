import type { BrowserPlatform } from "shade-ui/src/bridge/index";
import { browserLibraryCache } from "./browser-library-cache";
import { browserMediaPlatform } from "./browser-media-platform";
import { browserSnapshotsPlatform } from "./browser-snapshots-platform";
import { getSharedWorker } from "./shared-worker";

export const browserPlatform: BrowserPlatform = {
  kind: "browser",
  libraryCache: browserLibraryCache,
  // The bridge's legacy workerCall path expects a Worker. It gets the same
  // shared instance the unified Transport uses so wasm state is consistent.
  createWorker: () => getSharedWorker(),
  media: browserMediaPlatform,
  snapshots: browserSnapshotsPlatform,
};
