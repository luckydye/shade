import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { HostHooks, NativeDragDropPayload } from "shade-ui/src/types";
import { tauriLibraryCache } from "./tauri-library-cache";

function normalizeDialogPath(path: string | string[] | null): string | null {
  if (path === null) {
    return null;
  }
  if (Array.isArray(path)) {
    throw new Error("expected a single filesystem path");
  }
  return path;
}

export const tauriHostHooks: HostHooks = {
  ...tauriLibraryCache,
  async pickDirectory() {
    return normalizeDialogPath(
      await open({
        directory: true,
        multiple: false,
      }),
    );
  },
  pickExportTarget() {
    return save({
      title: "Export Render",
      filters: [
        { name: "PNG Image", extensions: ["png"] },
        { name: "JPEG Image", extensions: ["jpg", "jpeg"] },
      ],
    });
  },
  async listenNativeDragDrop(listener) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const { payload } = event;
      if (!("paths" in payload) || !Array.isArray(payload.paths)) {
        throw new Error("native drag-drop event is missing paths");
      }
      listener({
        type: payload.type as NativeDragDropPayload["type"],
        paths: payload.paths,
      });
    });
  },

  // ── Image lifecycle ─────────────────────────────────────────────────
  async openImage(path) {
    return invoke("open_image", { path });
  },
  async openImageFile(file) {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke("open_image_encoded_bytes", {
      bytes,
      file_name: file.name,
    });
  },
  async openPeerImage(peerEndpointId, picture) {
    return invoke("open_peer_image", {
      peerEndpointId,
      pictureId: picture.id,
      file_name: picture.name,
    });
  },
  async prepareImageOpen() {
    // Tauri loads the image fully when `openImage` is invoked; no separate
    // prepare phase.
  },
  async exportImage(path) {
    await invoke("export_image", { path });
  },
  async renderPreview() {
    throw new Error("renderPreview is browser-only; tauri uses the push preview channel");
  },
  async getLayerStack() {
    throw new Error(
      "getLayerStack is browser-only — tauri receives the stack via LayerStackSnapshot",
    );
  },
  async getMaskThumbnail(layerIdx, maxW, maxH) {
    return invoke("get_mask_thumbnail", {
      params: { layer_idx: layerIdx, max_w: maxW, max_h: maxH },
    });
  },
  async restoreCurrentBrowserSnapshot() {
    // Tauri restores edit state automatically when an image is opened.
    return false;
  },
};
