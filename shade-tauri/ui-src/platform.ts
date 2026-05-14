import type { TauriPlatform } from "shade-ui/src/bridge/index";
import { tauriPlatform } from "./tauri-platform";

export const platform: TauriPlatform = {
  ...tauriPlatform,
  kind: "tauri",
};
