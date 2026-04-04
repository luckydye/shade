import type { ThumbnailBackend } from "shade-ui/src/bridge/thumbnail-backend";
import { browserMediaPlatform } from "./browser-media-platform";

export const browserThumbnailBackend: ThumbnailBackend = {
  getThumbnailBytes(path) {
    return browserMediaPlatform.getThumbnailBytes(path);
  },
  async getPeerThumbnailBytes() {
    return new Uint8Array();
  },
};
