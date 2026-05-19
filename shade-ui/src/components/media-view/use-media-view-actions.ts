import type { Accessor, Setter } from "solid-js";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { actions } from "../../store/actions";
import { registerMediaBrowserController } from "../../store/media-browser-control";
import type { LibraryEntry } from "./media-utils";

export function useMediaViewActions(params: {
  selectedLibraryId: Accessor<string | null>;
  setSelectedLibraryId: Setter<string | null>;
  libraryEntries: Accessor<LibraryEntry[]>;
  flatItemIds: Accessor<string[]>;
  selectedFocusedItemId: Accessor<string | null>;
  setFocusedItemId: Setter<string | null>;
  setSelectedMediaItemIds: Setter<string[]>;
  setKeyboardNavActive: Setter<boolean>;
  toggleMediaSelection: (itemId: string) => void;
  navigateFocus: (direction: "left" | "right" | "up" | "down") => void;
  setZoomIndex: Setter<number>;
  zoomLevelCount: number;
  syncProgress: Accessor<unknown>;
  refetchItems: () => unknown;
  pasteEdits: (presetName: string) => Promise<void>;
}) {
  onMount(() => {
    const unregisterMediaBrowserController = registerMediaBrowserController({
      selectLibrary(libraryId) {
        params.setSelectedLibraryId(libraryId);
      },
      getSelectedLibraryId() {
        return params.selectedLibraryId();
      },
      async pasteEdits(presetName: string) {
        await params.pasteEdits(presetName);
      },
    });

    createEffect(
      on(params.syncProgress, (current, prev) => {
        if (prev && !current) void params.refetchItems();
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
        params.setKeyboardNavActive(true);
        const ids = params.flatItemIds();
        params.setSelectedMediaItemIds(ids);
        if (!params.selectedFocusedItemId() && ids.length > 0) {
          params.setFocusedItemId(ids[0]);
        }
      },
    });

    actions.register({
      id: "media.toggle-selection",
      title: "Toggle Image Selection",
      group: "Media",
      when: (ctx) => ctx.currentView === "media" && ctx.mediaViewFocusedItemId !== null,
      run: () => {
        const id = params.selectedFocusedItemId();
        if (id) {
          params.setKeyboardNavActive(true);
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
          params.setKeyboardNavActive(true);
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
        const entries = params.libraryEntries();
        if (entries.length === 0) return;
        const idx = entries.findIndex((lib) => lib.id === params.selectedLibraryId());
        const nextIdx = idx <= 0 ? entries.length - 1 : idx - 1;
        params.setSelectedLibraryId(entries[nextIdx].id);
      },
    });

    actions.register({
      id: "media.next-library",
      title: "Next Library",
      group: "Media",
      when: mediaWhen,
      run: () => {
        const entries = params.libraryEntries();
        if (entries.length === 0) return;
        const idx = entries.findIndex((lib) => lib.id === params.selectedLibraryId());
        const nextIdx = idx === -1 || idx >= entries.length - 1 ? 0 : idx + 1;
        params.setSelectedLibraryId(entries[nextIdx].id);
      },
    });

    actions.register({
      id: "media.zoom-in",
      title: "Zoom In",
      group: "Media",
      when: mediaWhen,
      run: () => {
        params.setZoomIndex((i) => Math.min(params.zoomLevelCount - 1, i + 1));
      },
    });

    actions.register({
      id: "media.zoom-out",
      title: "Zoom Out",
      group: "Media",
      when: mediaWhen,
      run: () => {
        params.setZoomIndex((i) => Math.max(0, i - 1));
      },
    });

    const handlePointerDown = () => {
      params.setKeyboardNavActive(false);
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
