import type { Component } from "solid-js";
import { Show } from "solid-js";
import { useEdgeSwipe } from "../app/use-edge-swipe";
import backSvg from "../assets/icons/back.svg?raw";
import { showMediaView, state } from "../store/editor-store";
import { tw } from "../utils";
import { ActionButton } from "./ActionButton";
import { CollectionSidebar } from "./media-view/CollectionSidebar";
import { LibrarySelector } from "./media-view/LibrarySelector";
import { MobileMediaSearch } from "./media-view/MobileMediaSearch";
import { PictureGrid } from "./media-view/PictureGrid";
import { SelectionBar } from "./media-view/SelectionBar";
import { UploadDropOverlay } from "./media-view/UploadDropOverlay";
import { useMediaViewModel } from "./media-view/use-media-view-model";

export const MediaView: Component = () => {
  const model = useMediaViewModel();
  const handleEdgeSwipe = useEdgeSwipe({
    onSwipe: () => model.collections.setMobileSidebarOpen(true),
  });

  const isEditorStrip = () => state.currentView === "editor";

  return (
    <section
      class={tw(
        `mobile-slider-fade outline-none relative transition-opacity duration-150`,
        isEditorStrip()
          ? "flex w-[112px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel-bg)] touch-compact:hidden"
          : "flex flex-1 flex-col overflow-hidden pt-0 touch-compact:pt-[calc(env(safe-area-inset-top)+3.5rem)]",
      )}
    >
      <UploadDropOverlay />

      <Show when={!isEditorStrip()}>
        <div class="flex border-b border-[var(--border)] px-4 py-4 touch-mobile:px-4">
          <LibrarySelector />
        </div>
      </Show>

      <div class="relative flex-1 min-h-0 flex" onTouchStart={handleEdgeSwipe}>
        <Show when={!isEditorStrip() && model.selectedLibrary()}>
          <CollectionSidebar />
        </Show>
        <div class="relative flex-1 min-h-0 flex flex-col">
          <Show when={state.currentView === "editor"}>
            <div class="px-2 pt-2 pb-1 w-full flex">
              <ActionButton
                class="w-full"
                label="Back"
                icon={backSvg}
                onClick={() => {
                  showMediaView();
                }}
              />
            </div>
          </Show>

          <Show
            when={
              !isEditorStrip() &&
              !model.isLibraryScanComplete() &&
              model.availableItems().length > 0
            }
          >
            <div class="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-5 py-2 text-[11px] font-medium text-[var(--text-dim)]">
              <div class="h-2.5 w-2.5 animate-spin rounded-full border border-[var(--border-medium)] border-t-[var(--text-muted)]" />
              Indexing · {model.availableItems().length.toLocaleString()} images found so
              far
            </div>
          </Show>

          <PictureGrid />
        </div>
      </div>

      <div
        class={`${isEditorStrip() ? "hidden" : "flex"} flex-col gap-2 border-t border-[var(--border)] px-4 touch-mobile:hidden lg:px-6`}
      >
        <SelectionBar />
      </div>

      <Show when={model.selectedLibrary()}>
        <MobileMediaSearch />
      </Show>
    </section>
  );
};
