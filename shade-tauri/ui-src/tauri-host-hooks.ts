import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  HostHooks,
  NativeDragDropPayload,
} from "shade-ui/src/bridge/host";

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
};
