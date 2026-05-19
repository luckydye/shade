import type { ActionDef } from "../store/actions";
import { state } from "../store/editor-store";
import { useOpenImage } from "../utils/use-open-image";

export const ToolbarExport = {
  id: "toolbar.export",
  title: "Export",
  group: "Toolbar",
  when: () => state.canvasWidth > 0 && state.canvasHeight > 0,
  run: async () => {
    const image = useOpenImage();
    const path = await image.pickExportTarget();
    if (!path) {
      return;
    }
    await image.exportTo(path);
  },
} satisfies ActionDef;
