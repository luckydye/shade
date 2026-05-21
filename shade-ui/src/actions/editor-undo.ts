import type { ActionDef } from "../utils/actions";
import { undo } from "../utils/history";

export const EditorUndo = {
  id: "editor.undo",
  title: "Undo",
  group: "Editor",
  when: (ctx) => ctx.hasImage,
  run: () => undo(),
} satisfies ActionDef;
