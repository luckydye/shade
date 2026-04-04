import { getPlatform } from "./index";

export interface ThumbnailBackend {
  getThumbnailBytes(path: string): Promise<Uint8Array>;
  getPeerThumbnailBytes(peerId: string, pictureId: string): Promise<Uint8Array>;
}

export function getThumbnailBackend(): ThumbnailBackend {
  return getPlatform().thumbnailBackend;
}
