import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TauriPlatform } from "shade-ui/src/bridge/index";

export const platform: TauriPlatform = {
  kind: "tauri",
  isTauri,
  invoke(cmd, args) {
    return invoke(cmd, args);
  },
};
