import type { ActionDef } from "../utils/actions";
import { redo } from "../utils/history";

export const EditorRedo = {
  id: "editor.redo",
  title: "Redo",
  group: "Editor",
  when: (ctx) => ctx.hasImage,
  run: () => redo(),
} satisfies ActionDef;
