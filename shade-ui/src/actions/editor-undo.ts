import type { ActionDef } from "../store/actions";
import { undo } from "../store/history";

export const EditorUndo = {
  id: "editor.undo",
  title: "Undo",
  group: "Editor",
  when: (ctx) => ctx.hasImage,
  run: () => undo(),
} satisfies ActionDef;
