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
  | "listenLibrarySyncProgress"
  | "listenLibraryScanComplete"
  | "listenLibraryScanProgress"
  | "listenImageOpenPhase"
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
  async listenLibrarySyncProgress(listener) {
    const unlisten = await listen<{ library_id: string; total: number; completed: number; current_name: string | null }>("library-sync-progress", (event) => {
      listener(event.payload);
    });
    return () => {
      void unlisten();
    };
  },
  async listenLibraryScanComplete(listener) {
    const unlisten = await listen<string>("library-scan-complete", (event) => {
      listener(event.payload);
    });
    return () => {
      void unlisten();
    };
  },
  async listenLibraryScanProgress(listener) {
    const unlisten = await listen<string>("library-scan-progress", (event) => {
      listener(event.payload);
    });
    return () => {
      void unlisten();
    };
  },
  async listenImageOpenPhase(listener) {
    const unlisten = await listen<string>("image-open-phase", (event) => {
      listener(event.payload);
    });
    return () => {
      void unlisten();
    };
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
