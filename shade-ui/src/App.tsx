import {
  type Component,
  createEffect,
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
import { setState, showEditorView, showMediaView, state } from "./store/editor-store";
import { checkWebGPU } from "./utils/webgpu-check";

type AppView = "media" | "editor";
type MobileHistoryState = { shadeView: AppView };

const MEDIA_HISTORY_STATE: MobileHistoryState = { shadeView: "media" };
const EDITOR_HISTORY_STATE: MobileHistoryState = { shadeView: "editor" };
let actionShortcutsLoaded = false;

function historyView(value: unknown): AppView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const shadeView = (value as { shadeView?: unknown }).shadeView;
  return shadeView === "media" || shadeView === "editor" ? shadeView : null;
}

const App: Component = () => {
  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  const showEditor = () => hasImage() && state.currentView === "editor";
  let isHandlingHistoryPop = false;
  let lastSyncedView: AppView = state.currentView;

  onMount(() => {
    window.history.replaceState(MEDIA_HISTORY_STATE, "");
    lastSyncedView = state.currentView;
    if (state.currentView === "editor") {
      window.history.pushState(EDITOR_HISTORY_STATE, "");
    }
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

  onMount(() => {
    const handlePopState = (event: PopStateEvent) => {
      const requestedView = historyView(event.state) ?? "media";
      isHandlingHistoryPop = true;
      try {
        if (requestedView === "editor") {
          if (state.selectedArtboardId === null && !state.isLoading) {
            window.history.replaceState(MEDIA_HISTORY_STATE, "");
            showMediaView();
            return;
          }
          showEditorView();
          return;
        }
        showMediaView();
      } finally {
        queueMicrotask(() => {
          isHandlingHistoryPop = false;
          lastSyncedView = state.currentView;
        });
      }
    };
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  createEffect(() => {
    const currentView = state.currentView;
    if (isHandlingHistoryPop || currentView === lastSyncedView) {
      lastSyncedView = currentView;
      return;
    }
    if (currentView === "editor") {
      window.history.pushState(EDITOR_HISTORY_STATE, "");
      lastSyncedView = currentView;
      return;
    }
    if (historyView(window.history.state) === "editor") {
      isHandlingHistoryPop = true;
      window.history.back();
      return;
    }
    window.history.replaceState(MEDIA_HISTORY_STATE, "");
    lastSyncedView = currentView;
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
