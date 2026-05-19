import type { Component } from "solid-js";
import { useEditorActions } from "./editor-view/use-editor-actions";
import { Inspector } from "./Inspector";
import { Viewport } from "./Viewport";

export const EditorView: Component = () => {
  useEditorActions();

  return (
    <div class="flex min-h-0 flex-1 flex-row touch-compact:flex-col">
      <Viewport />
      <Inspector />
    </div>
  );
};
