import { onCleanup, onMount } from "solid-js";
import { EditorCopy } from "../actions/editor-copy";
import { EditorPaste } from "../actions/editor-paste";
import { EditorRedo } from "../actions/editor-redo";
import { EditorUndo } from "../actions/editor-undo";
import { actions } from "./actions";

export function useEditorActions() {
  onMount(() => {
    actions.register(EditorUndo);
    actions.register(EditorRedo);
    actions.register(EditorCopy);
    actions.register(EditorPaste);

    onCleanup(() => {
      actions.unregister("editor.undo");
      actions.unregister("editor.redo");
      actions.unregister("editor.copy-edits");
      actions.unregister("editor.paste-edits");
    });
  });
}
