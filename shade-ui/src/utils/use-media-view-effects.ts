import { type Accessor, createEffect, onCleanup, onMount, type Setter } from "solid-js";
import {
  isCameraLibrary,
  type LibraryEntry,
} from "../components/media-view/media-utils";
import { actions, buildActionContext } from "./actions";
import { state } from "./editor-store";
import type { LibraryData } from "./use-library-items";
import type { useMediaSelection } from "./use-media-selection";

type MediaSelection = ReturnType<typeof useMediaSelection>;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaViewEffects(params: {
  selectedLibraryId: Accessor<string | null>;
  selectedLibrary: Accessor<LibraryEntry | null>;
  selectedLibraryIsRefreshing: Accessor<boolean>;
  items: Accessor<LibraryData | undefined> & { loading: boolean };
  normalizedFilenameFilter: Accessor<string[]>;
  refetchItems: () => unknown;
  refetchLibraries: () => unknown;
  syncLibrary: (libraryId: string) => Promise<unknown>;
  syncProgress: Accessor<unknown>;
  setError: Setter<string | null>;
  selection: MediaSelection;
}) {
  let isDisposed = false;

  function syncSelectedLibraryIfNeeded() {
    const library = params.selectedLibrary();
    if (!library || library.mode !== "sync" || params.syncProgress()) {
      return;
    }
    void params.syncLibrary(library.id).catch((err) => {
      params.setError(toErrorMessage(err));
    });
  }

  onMount(() => {
    const libraryRefreshTimer = window.setInterval(() => {
      void Promise.resolve(params.refetchLibraries()).catch(() => undefined);
      syncSelectedLibraryIfNeeded();
    }, 3000);
    onCleanup(() => {
      isDisposed = true;
      window.clearInterval(libraryRefreshTimer);
    });
  });

  createEffect(() => {
    params.selectedLibraryId();
    // actions.run("media.grid.reset-scroll", buildActionContext());
    params.selection.setSelectedMediaItemIds([]);
  });

  createEffect(() => {
    params.normalizedFilenameFilter();
    // actions.run("media.grid.reset-scroll", buildActionContext());
  });

  createEffect(() => {
    if (state.currentView !== "media" || !params.selectedLibraryId()) {
      return;
    }
    void params.refetchItems();
  });

  createEffect(() => {
    const library = params.selectedLibrary();
    if (!library || !isCameraLibrary(library)) {
      return;
    }
    const current = params.items();
    if (
      params.items.loading ||
      !current ||
      current.libraryId !== library.id ||
      (current.isComplete && !params.selectedLibraryIsRefreshing())
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (isDisposed) {
        return;
      }
      void Promise.resolve(params.refetchItems()).catch((error) => {
        params.setError(toErrorMessage(error));
      });
    }, 300);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const id = params.selection.focusedItemId();
    if (!id || !params.selection.keyboardNavActive()) return;
    actions.run("media.grid.scroll-focused-into-view", buildActionContext());
  });
}
