import { usePresetList } from "../utils/use-preset-list";
import type { ActionDef } from "../store/actions";
import { mediaViewFocusedItem } from "../store/media-view-context";
import { showToast } from "../store/toast";

export const EditorCopy = {
  id: "editor.copy-edits",
  title: "Copy Edits",
  group: "Editor",
  when: (ctx) =>
    (ctx.hasImage && ctx.currentView === "editor") ||
    (ctx.currentView === "media" && ctx.mediaViewFocusedItemId !== null),
  run: async (ctx) => {
    const { getSnapshotPresetJson, serializeCurrentPreset } = usePresetList();
    let json: string | null;
    if (ctx.currentView === "media") {
      const item = mediaViewFocusedItem();
      if (!item) return;
      json = await getSnapshotPresetJson(item.fingerprint, item.path);
      if (!json) {
        showToast("No edits to copy");
        return;
      }
    } else {
      json = await serializeCurrentPreset();
    }
    await navigator.clipboard.writeText(json);
    showToast("Edits copied");
  },
} satisfies ActionDef;
