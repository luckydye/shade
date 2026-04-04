import type { ThumbnailBackend } from "shade-ui/src/bridge/thumbnail-backend";
import { tauriPlatform } from "./tauri-platform";

function normalizeBytes(
  result: number[] | Uint8Array | ArrayBuffer,
): Uint8Array {
  if (result instanceof Uint8Array) {
    return Uint8Array.from(result);
  }
  if (result instanceof ArrayBuffer) {
    return new Uint8Array(result);
  }
  return Uint8Array.from(result);
}

export const tauriThumbnailBackend: ThumbnailBackend = {
  async getThumbnailBytes(path) {
    return normalizeBytes(
      (await tauriPlatform.invoke("get_thumbnail", {
        path,
      })) as number[] | Uint8Array | ArrayBuffer,
    );
  },
  async getPeerThumbnailBytes(peerId, pictureId) {
    return normalizeBytes(
      (await tauriPlatform.invoke("get_peer_thumbnail", {
        peerEndpointId: peerId,
        pictureId,
      })) as number[] | Uint8Array | ArrayBuffer,
    );
  },
};
