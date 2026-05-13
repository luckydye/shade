import { Component, createEffect, onCleanup, onMount } from "solid-js";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { Viewport } from "./components/Viewport";
import { MediaView } from "./components/MediaView";
import { checkWebGPU } from "./bridge/webgpu-check";
import { showEditorView, showMediaView } from "./store/editor";
import { setState, state } from "./store/editor-store";
import { undo, redo } from "./store/history";
import { loadPreset } from "./store/editor-layers";
import { serializeCurrentPreset, savePresetFromJson, deletePreset, getSnapshotPresetJson } from "./bridge/index";
import { targetAcceptsTextInput } from "./components/media-view/media-utils";
import { actions, buildActionContext } from "./store/actions";
import { CLIPBOARD_PRESET_NAME } from "./store/edit-clipboard";
import { getMediaBrowserController } from "./store/media-browser-control";
import { mediaViewFocusedItem } from "./store/media-view-context";
import { showToast } from "./store/toast";
import { Toast } from "./components/Toast";

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
    actions.register({
      id: "editor.undo",
      title: "Undo",
      group: "Editor",
      when: (ctx) => ctx.hasImage,
      run: () => undo(),
    });

    actions.register({
      id: "editor.redo",
      title: "Redo",
      group: "Editor",
      when: (ctx) => ctx.hasImage,
      run: () => redo(),
    });

    actions.register({
      id: "editor.copy-edits",
      title: "Copy Edits",
      group: "Editor",
      when: (ctx) =>
        (ctx.hasImage && ctx.currentView === "editor") ||
        (ctx.currentView === "media" && ctx.mediaViewFocusedItemId !== null),
      run: async (ctx) => {
        let json: string | null;
        if (ctx.currentView === "media") {
          const item = mediaViewFocusedItem();
          if (!item) return;
          json = await getSnapshotPresetJson(item.fingerprint, item.path);
          if (!json) { showToast("No edits to copy"); return; }
        } else {
          json = await serializeCurrentPreset();
        }
        await navigator.clipboard.writeText(json);
        showToast("Edits copied");
      },
    });

    actions.register({
      id: "editor.paste-edits",
      title: "Paste Edits",
      group: "Editor",
      when: (ctx) => {
        if (ctx.currentView === "editor") return ctx.hasImage;
        if (ctx.currentView === "media") return ctx.mediaViewSelectedItemIds.length > 0;
        return false;
      },
      run: async (ctx) => {
        let json: string;
        try {
          json = await navigator.clipboard.readText();
          JSON.parse(json);
        } catch {
          showToast("Nothing to paste");
          return;
        }
        try {
          await savePresetFromJson(CLIPBOARD_PRESET_NAME, json);
          if (ctx.currentView === "editor") {
            await loadPreset(CLIPBOARD_PRESET_NAME);
            showToast("Edits pasted");
          } else {
            await getMediaBrowserController().pasteEdits(CLIPBOARD_PRESET_NAME);
            showToast(`Edits pasted to ${ctx.mediaViewSelectedItemIds.length} image${ctx.mediaViewSelectedItemIds.length > 1 ? "s" : ""}`);
          }
        } finally {
          await deletePreset(CLIPBOARD_PRESET_NAME).catch(() => undefined);
        }
      },
    });

    actions.mapShortcut("mod+z", "editor.undo");
    actions.mapShortcut("mod+shift+z", "editor.redo");
    actions.mapShortcut("mod+c", "editor.copy-edits");
    actions.mapShortcut("mod+v", "editor.paste-edits");

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
        <div
          class={`min-h-0 flex-1 flex-row touch-compact:flex-col ${showEditor() ? "flex" : "hidden"}`}
        >
          <Viewport />
          <Inspector />
        </div>
      </div>
      <Toast />
    </div>
  );
};

export default App;
