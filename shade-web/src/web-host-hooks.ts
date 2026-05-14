import type {
  HostHooks,
  NativeDragDropPayload,
} from "shade-ui/src/bridge/host";
import { browserLibraryCache } from "./library-cache";

/**
 * Web host-hook implementation. Uses File System Access APIs for the
 * pickers and listens to native drag/drop on `window`.
 *
 * If the browser lacks `showDirectoryPicker` / `showSaveFilePicker` the
 * methods reject with a clear message — the UI should disable the
 * corresponding controls.
 */
export const webHostHooks: HostHooks = {
  ...browserLibraryCache,
  async pickDirectory() {
    const win = window as unknown as {
      showDirectoryPicker?: () => Promise<{ name: string }>;
    };
    if (!win.showDirectoryPicker) {
      throw new Error("directory picker is unavailable in this browser");
    }
    const handle = await win.showDirectoryPicker();
    return handle.name;
  },
  async pickExportTarget() {
    const win = window as unknown as {
      showSaveFilePicker?: (
        opts: Record<string, unknown>,
      ) => Promise<{ name: string }>;
    };
    if (!win.showSaveFilePicker) {
      throw new Error("save dialog is unavailable in this browser");
    }
    const handle = await win.showSaveFilePicker({
      types: [
        { description: "PNG Image", accept: { "image/png": [".png"] } },
        {
          description: "JPEG Image",
          accept: { "image/jpeg": [".jpg", ".jpeg"] },
        },
      ],
    });
    return handle.name;
  },
  async listenNativeDragDrop(listener) {
    const drag = (type: NativeDragDropPayload["type"]) => (event: DragEvent) => {
      event.preventDefault();
      const paths: string[] = [];
      if (event.dataTransfer) {
        for (const item of Array.from(event.dataTransfer.files)) {
          paths.push(item.name);
        }
      }
      listener({ type, paths });
    };
    const onEnter = drag("enter");
    const onOver = drag("over");
    const onDrop = drag("drop");
    const onLeave = drag("leave");
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onLeave);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onLeave);
    };
  },
};
