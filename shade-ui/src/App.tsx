import {
  type Component,
  onCleanup,
  onMount,
} from "solid-js";
import actionShortcuts from "./keybinds.json";
import { EditorCopy } from "./actions/editor-copy";
import { EditorPaste } from "./actions/editor-paste";
import { EditorRedo } from "./actions/editor-redo";
import { EditorUndo } from "./actions/editor-undo";
import { Inspector } from "./components/Inspector";
import { MediaView } from "./components/MediaView";
import { targetAcceptsTextInput } from "./components/media-view/media-utils";
import { StatusPanel } from "./components/StatusPanel";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { Viewport } from "./components/Viewport";
import { actions, type ActionShortcutMap, buildActionContext } from "./store/actions";
import { setState, state } from "./store/editor-store";
import { useNavigationHistory } from "./app/use-navigation-history";
import { checkWebGPU } from "./utils/webgpu-check";

let actionShortcutsLoaded = false;

const App: Component = () => {
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const showEditor = () => hasImage() && state.currentView === "editor";
  
  useNavigationHistory();

  onMount(() => {
    void (async () => {
      const webgpu = await checkWebGPU();
      setState({
        webgpuAvailable: webgpu.available,
        webgpuReason: webgpu.available ? null : (webgpu.reason ?? "WebGPU unavailable"),
      });
    })();
  });

  onMount(() => {
    if (!actionShortcutsLoaded) {
      actions.loadShortcuts(actionShortcuts as ActionShortcutMap);
      actionShortcutsLoaded = true;
    }

    actions.register(EditorUndo);
    actions.register(EditorRedo);
    actions.register(EditorCopy);
    actions.register(EditorPaste);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (targetAcceptsTextInput(e.target)) return;
      if (e.defaultPrevented) return;
      const handled = actions.handleKey(e, buildActionContext());
      if (handled) return;
    };
    document.addEventListener("keydown", handleKeyDown);
    
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
      actions.unregister("editor.undo");
      actions.unregister("editor.redo");
      actions.unregister("editor.copy-edits");
      actions.unregister("editor.paste-edits");
    });
  });

  return (
    <div class="bg-surface-background relative flex h-screen w-screen select-none flex-col overflow-hidden text-[var(--text)]">
      <Toolbar />
      <div class="flex min-h-0 flex-1">
        <MediaView />
        {/*<div
          class={`min-h-0 flex-1 flex-row touch-compact:flex-col ${showEditor() ? "flex" : "hidden"}`}
        >
          <Viewport />
          <Inspector />
        </div>*/}
      </div>
      <StatusPanel />
      <Toast />
    </div>
  );
};

export default App;
