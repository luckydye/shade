import { createEffect, on, onCleanup, onMount } from "solid-js";
import { useMediaViewStore } from "../components/media-view/media-view-store";
import {
  zoomPictureGridIn,
  zoomPictureGridOut,
} from "../components/media-view/picture-grid-state";
import { actions } from "../store/actions";
import { registerMediaBrowserController } from "../store/media-browser-control";

export function useMediaViewActions(params: {
  toggleMediaSelection: (itemId: string) => void;
  navigateFocus: (direction: "left" | "right" | "up" | "down") => void;
  pasteEdits: (presetName: string) => Promise<void>;
}) {
  const store = useMediaViewStore();
  onMount(() => {
    const unregisterMediaBrowserController = registerMediaBrowserController({
      selectLibrary(libraryId) {
        store.setSelectedLibraryId(libraryId);
      },
      getSelectedLibraryId() {
        return store.selectedLibraryId();
      },
      async pasteEdits(presetName: string) {
        await params.pasteEdits(presetName);
      },
    });

    createEffect(
      on(store.syncProgress, (current, prev) => {
        if (prev && !current) void store.refetchItems();
      }),
    );

    const mediaWhen = (ctx: { currentView: string; selectedLibraryId: string | null }) =>
      ctx.currentView === "media" && ctx.selectedLibraryId !== null;

    actions.register({
      id: "media.select-all",
      title: "Select All Images",
      group: "Media",
      when: mediaWhen,
      run: () => {
        store.setKeyboardNavActive(true);
        const ids = store.flatItemIds();
        store.setSelectedMediaItemIds(ids);
        if (!store.focusedItemId() && ids.length > 0) {
          store.setFocusedItemId(ids[0]);
        }
      },
    });

    actions.register({
      id: "media.toggle-selection",
      title: "Toggle Image Selection",
      group: "Media",
      when: (ctx) => ctx.currentView === "media" && ctx.mediaViewFocusedItemId !== null,
      run: () => {
        const id = store.focusedItemId();
        if (id) {
          store.setKeyboardNavActive(true);
          params.toggleMediaSelection(id);
        }
      },
    });

    for (const [id, title, direction] of [
      ["media.navigate-up", "Navigate Up", "up"],
      ["media.navigate-down", "Navigate Down", "down"],
      ["media.navigate-left", "Navigate Left", "left"],
      ["media.navigate-right", "Navigate Right", "right"],
    ] as const) {
      actions.register({
        id,
        title,
        group: "Media",
        when: mediaWhen,
        run: () => {
          store.setKeyboardNavActive(true);
          params.navigateFocus(direction);
        },
      });
    }

    actions.register({
      id: "media.prev-library",
      title: "Previous Library",
      group: "Media",
      when: mediaWhen,
      run: () => {
        const entries = store.libraryEntries();
        if (entries.length === 0) return;
        const idx = entries.findIndex((lib) => lib.id === store.selectedLibraryId());
        const nextIdx = idx <= 0 ? entries.length - 1 : idx - 1;
        store.setSelectedLibraryId(entries[nextIdx].id);
      },
    });

    actions.register({
      id: "media.next-library",
      title: "Next Library",
      group: "Media",
      when: mediaWhen,
      run: () => {
        const entries = store.libraryEntries();
        if (entries.length === 0) return;
        const idx = entries.findIndex((lib) => lib.id === store.selectedLibraryId());
        const nextIdx = idx === -1 || idx >= entries.length - 1 ? 0 : idx + 1;
        store.setSelectedLibraryId(entries[nextIdx].id);
      },
    });

    actions.register({
      id: "media.zoom-in",
      title: "Zoom In",
      group: "Media",
      when: mediaWhen,
      run: () => {
        zoomPictureGridIn();
      },
    });

    actions.register({
      id: "media.zoom-out",
      title: "Zoom Out",
      group: "Media",
      when: mediaWhen,
      run: () => {
        zoomPictureGridOut();
      },
    });

    const handlePointerDown = () => {
      store.setKeyboardNavActive(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    onCleanup(() => {
      unregisterMediaBrowserController();
      document.removeEventListener("pointerdown", handlePointerDown);
      actions.unregister("media.select-all");
      actions.unregister("media.toggle-selection");
      actions.unregister("media.navigate-up");
      actions.unregister("media.navigate-down");
      actions.unregister("media.navigate-left");
      actions.unregister("media.navigate-right");
      actions.unregister("media.prev-library");
      actions.unregister("media.next-library");
      actions.unregister("media.zoom-in");
      actions.unregister("media.zoom-out");
    });
  });
}
