import type { ActionDef } from "../store/actions";
import { redo } from "../store/history";

export const EditorRedo = {
  id: "editor.redo",
  title: "Redo",
  group: "Editor",
  when: (ctx) => ctx.hasImage,
  run: () => redo(),
} satisfies ActionDef;
