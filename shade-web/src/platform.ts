import type { BrowserPlatform } from "shade-ui/src/bridge/index";
import { browserMediaPlatform } from "./media";
import { browserSnapshotsPlatform } from "./worker/snapshots";
import { getSharedWorker } from "./shared-worker";

export const browserPlatform: BrowserPlatform = {
  kind: "browser",
  // The bridge's legacy workerCall path expects a Worker. It gets the same
  // shared instance the unified Transport uses so wasm state is consistent.
  createWorker: () => getSharedWorker(),
  media: browserMediaPlatform,
  snapshots: browserSnapshotsPlatform,
};
