import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import type { PresetInfo } from "../bridge/types";

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
  savePreset: (name: string) => Promise<void>;
  renamePreset: (oldName: string, newName: string) => Promise<void>;
  deletePreset: (name: string) => Promise<void>;
  savePresetFromJson: (name: string, json: string) => Promise<void>;
  serializeCurrentPreset: () => Promise<string>;
  getSnapshotPresetJson: (
    fingerprint: string | null,
    imagePath: string,
  ) => Promise<string | null>;
} {
  return {
    presets,
    refetch: async () => {
      await refetch();
    },
    savePreset,
    renamePreset,
    deletePreset,
    savePresetFromJson,
    serializeCurrentPreset,
    getSnapshotPresetJson,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// All preset writes funnel through this module. Rust emits `preset_list_changed`
// after each mutation, which triggers the auto-refetch wired above.

async function savePreset(name: string): Promise<void> {
  await bridge.savePreset(name);
}

async function renamePreset(oldName: string, newName: string): Promise<void> {
  await bridge.renamePreset(oldName, newName);
}

function deletePreset(name: string): Promise<void> {
  return bridge.deletePreset(name);
}

function savePresetFromJson(name: string, json: string): Promise<void> {
  return bridge.savePresetFromJson(name, json);
}

function serializeCurrentPreset(): Promise<string> {
  return bridge.serializeCurrentPreset();
}

function getSnapshotPresetJson(
  fingerprint: string | null,
  imagePath: string,
): Promise<string | null> {
  return bridge.getSnapshotPresetJson(fingerprint, imagePath);
}
