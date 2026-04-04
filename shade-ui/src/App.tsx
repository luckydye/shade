import { Component, createEffect, onCleanup, onMount } from "solid-js";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { Viewport } from "./components/Viewport";
import { MediaView } from "./components/MediaView";
import { checkWebGPU } from "./bridge/webgpu-check";
import { showEditorView, showMediaView } from "./store/editor";
import { setState, state } from "./store/editor-store";
import { undo, redo } from "./store/history";

type AppView = "media" | "editor";
type MobileHistoryState = { shadeView: AppView };

const MEDIA_HISTORY_STATE: MobileHistoryState = { shadeView: "media" };
const EDITOR_HISTORY_STATE: MobileHistoryState = { shadeView: "editor" };

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
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
    <div class="app-gradient relative flex h-screen w-screen select-none flex-col overflow-hidden text-[var(--text)]">
      <Toolbar />
      <div class="flex min-h-0 flex-1">
        <MediaView />
        <div
          class={`min-h-0 flex-1 flex-row touch-compact:flex-col ${showEditor() ? "flex" : "hidden"}`}
        >
          <Viewport />
          <Inspector />
        </div>
      </div>
    </div>
  );
};

export default App;
