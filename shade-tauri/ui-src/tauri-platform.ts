import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { NativeDragDropPayload, TauriPlatform } from "shade-ui/src/bridge/index";

type TauriPlatformApi = Pick<
  TauriPlatform,
  | "isTauri"
  | "invoke"
  | "pickDirectory"
  | "pickExportTarget"
  | "listenPeerPaired"
  | "listenNativeDragDrop"
>;

function normalizeDialogPath(path: string | string[] | null): string | null {
  if (path === null) {
    return null;
  }
  if (Array.isArray(path)) {
    throw new Error("expected a single filesystem path");
  }
  return path;
}

export const tauriPlatform: TauriPlatformApi = {
  isTauri,
  invoke(cmd, args) {
    return invoke(cmd, args);
  },
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
  async listenPeerPaired(listener) {
    const unlisten = await listen("peer-paired", listener);
    return () => {
      void unlisten();
    };
  },
  async listenNativeDragDrop(listener) {
    return getCurrentWebview().onDragDropEvent((event) => {
      const { payload } = event;
      if (!Array.isArray(payload.paths)) {
        throw new Error("native drag-drop event is missing paths");
      }
      listener({
        type: payload.type as NativeDragDropPayload["type"],
        paths: payload.paths,
      });
    });
  },
};
