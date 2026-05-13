import { getBrowserPlatform } from "./index";

/**
 * Browser-only thumbnail backend. The Tauri runtime serves thumbnails via the
 * `shade://thumb/...` custom protocol — use the URL helpers in `./channel.ts`
 * instead. This interface and `getThumbnailBackend()` exist only for the web
 * build's worker-backed thumbnail pipeline.
 */
export interface ThumbnailBackend {
  getThumbnailBytes(path: string): Promise<Uint8Array>;
  getPeerThumbnailBytes(peerId: string, pictureId: string): Promise<Uint8Array>;
}

export function getThumbnailBackend(): ThumbnailBackend {
  return getBrowserPlatform().thumbnailBackend;
}
