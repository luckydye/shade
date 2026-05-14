import { invoke, isTauri } from "@tauri-apps/api/core";
import type { TauriPlatform } from "shade-ui/src/bridge/index";

type TauriPlatformApi = Pick<TauriPlatform, "isTauri" | "invoke">;

export const tauriPlatform: TauriPlatformApi = {
  isTauri,
  invoke(cmd, args) {
    return invoke(cmd, args);
  },
};
