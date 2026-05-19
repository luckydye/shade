import { deletePreset, savePresetFromJson } from "#bridge";
import { useLayerStack } from "../data/use-layer-stack";
import type { ActionDef } from "../store/actions";
import { getMediaBrowserController } from "../store/media-browser-control";
import { showToast } from "../store/toast";

const CLIPBOARD_PRESET_NAME = "__clipboard__";

export const EditorPaste = {
  id: "editor.paste-edits",
  title: "Paste Edits",
  group: "Editor",
  when: (ctx) => {
    if (ctx.currentView === "editor") return ctx.hasImage;
    if (ctx.currentView === "media") return ctx.mediaViewSelectedItemIds.length > 0;
    return false;
  },
  run: async (ctx) => {
    let json: string;
    try {
      json = await navigator.clipboard.readText();
      JSON.parse(json);
    } catch {
      showToast("Nothing to paste");
      return;
    }
    try {
      await savePresetFromJson(CLIPBOARD_PRESET_NAME, json);
      if (ctx.currentView === "editor") {
        await useLayerStack().loadPreset(CLIPBOARD_PRESET_NAME);
        showToast("Edits pasted");
      } else {
        await getMediaBrowserController().pasteEdits(CLIPBOARD_PRESET_NAME);
        showToast(
          `Edits pasted to ${ctx.mediaViewSelectedItemIds.length} image${ctx.mediaViewSelectedItemIds.length > 1 ? "s" : ""}`,
        );
      }
    } finally {
      await deletePreset(CLIPBOARD_PRESET_NAME).catch(() => undefined);
    }
  },
} satisfies ActionDef;
