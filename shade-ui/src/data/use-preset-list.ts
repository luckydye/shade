import { createResource, createRoot, type InitializedResource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import { listPresets as fetchPresets, type PresetInfo } from "../bridge/index";

const { presets, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(fetchPresets, {
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
