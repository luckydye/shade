import { createEffect, onCleanup, onMount } from "solid-js";
import { showEditorView, showMediaView, state } from "./editor-store";

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

export function useNavigationHistory() {
  let isHandlingHistoryPop = false;
  let lastSyncedView: AppView = state.currentView;

  onMount(() => {
    window.history.replaceState(MEDIA_HISTORY_STATE, "");
    lastSyncedView = state.currentView;
    if (state.currentView === "editor") {
      window.history.pushState(EDITOR_HISTORY_STATE, "");
    }
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
}
