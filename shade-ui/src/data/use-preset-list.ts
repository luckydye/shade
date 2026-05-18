import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import { type PresetInfo } from "../bridge/types";

const { presets, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(bridge.listPresets, {
    initialValue: [] as PresetInfo[],
  });
  onChannelMessage("preset_list_changed", () => {
    void refetch();
  });
  return { presets: resource, refetch };
});

export function usePresetList(): {
  presets: InitializedResource<PresetInfo[]>;
  refetch: () => Promise<void>;
} {
  return {
    presets,
    refetch: async () => {
      await refetch();
    },
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// All preset writes funnel through this module. Rust emits `preset_list_changed`
// after each mutation, which triggers the auto-refetch wired above.

export function savePreset(name: string): Promise<PresetInfo | void> {
  return bridge.savePreset(name);
}

export function renamePreset(
  oldName: string,
  newName: string,
): Promise<PresetInfo | void> {
  return bridge.renamePreset(oldName, newName);
}

export function deletePreset(name: string): Promise<void> {
  return bridge.deletePreset(name);
}

export function savePresetFromJson(name: string, json: string): Promise<void> {
  return bridge.savePresetFromJson(name, json);
}

export function serializeCurrentPreset(): Promise<string> {
  return bridge.serializeCurrentPreset();
}

export function getSnapshotPresetJson(
  fingerprint: string | null,
  imagePath: string,
): Promise<string | null> {
  return bridge.getSnapshotPresetJson(fingerprint, imagePath);
}
