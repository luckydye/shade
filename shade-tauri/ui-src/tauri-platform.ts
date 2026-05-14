import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TauriPlatform } from "shade-ui/src/bridge/index";

type TauriPlatformApi = Pick<
  TauriPlatform,
  "isTauri" | "invoke" | "listenLibrarySyncProgress" | "listenImageOpenPhase"
>;

export const tauriPlatform: TauriPlatformApi = {
  isTauri,
  invoke(cmd, args) {
    return invoke(cmd, args);
  },
  async listenLibrarySyncProgress(listener) {
    const unlisten = await listen<{
      library_id: string;
      total: number;
      completed: number;
      current_name: string | null;
    }>("library-sync-progress", (event) => {
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
};
