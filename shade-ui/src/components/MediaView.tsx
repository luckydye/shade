import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useBatchOperations } from "../data/use-batch-operations";
import { useLayerStack } from "../data/use-layer-stack";
import { type MediaItem, useLibraryItems } from "../data/use-library-items";
import { useLibrarySyncProgress } from "../data/use-library-sync-progress";
import { useMediaLibraryList } from "../data/use-media-library-list";
import { usePeerDiscovery } from "../data/use-peer-discovery";
import { usePresetList } from "../data/use-preset-list";
import { useMediaViewStatus } from "../data/use-media-view-status";
import { isAdjustmentSliderActive, showMediaView, state } from "../store/editor-store";
import { ActionButton } from "./ActionButton";
import { CollectionSidebar } from "./media-view/CollectionSidebar";
import { LibrarySelector } from "./media-view/LibrarySelector";
import { PictureGrid } from "./media-view/PictureGrid";
import { SelectionBar } from "./media-view/SelectionBar";
import {
  filterMediaItemsByFilename,
  isCameraLibrary,
  isLibraryOffline,
  isLocalLibraryRefreshing,
  isPeerLibrary,
  isS3Library,
  type LibraryEntry,
  libraryIsWritable,
  mediaItemKey,
  normalizeFilenameFilter,
  peerLibraryPeerId,
  targetUsesOwnFocus,
} from "./media-view/media-utils";
import { useCollectionMembership } from "./media-view/use-collection-membership";
import { provideMediaViewStore } from "./media-view/media-view-store";
import { useMediaItemActions } from "./media-view/use-media-item-actions";
import { useMediaSelection } from "./media-view/use-media-selection";
import { useMediaUploadHandlers } from "./media-view/use-media-upload-handlers";
import { useMediaViewActions } from "./media-view/use-media-view-actions";
import { actions, buildActionContext } from "../store/actions";

const THUMBNAIL_MEMORY_BUFFER_SIZE = 192;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const MediaView: Component = () => {
  const layerOps = useLayerStack();
  const batchOps = useBatchOperations();
  const {
    libraries,
    refetch: refetchLibraries,
    addMediaLibrary,
    refreshLibraryIndex,
    syncLibrary,
    pickDirectory,
  } = useMediaLibraryList();
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const {
    items,
    cached: cachedLibraryItems,
    refetch: refetchLibraryItems,
    deleteMediaLibraryItem,
    uploadMediaLibraryFile,
    uploadMediaLibraryPath,
    uploadMediaLibraryUrl,
  } = useLibraryItems(selectedLibraryId);
  const refetchItems = () => refetchLibraryItems();
  const refetchCachedLibraryItems = () => refetchLibraryItems();
  const { presets, refetch: refetchPresets } = usePresetList();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [showApplyPresetMenu, setShowApplyPresetMenu] = createSignal(false);
  const [mediaActionStatus, setMediaActionStatus] = createSignal<string | null>(null);
  const [filenameFilter, setFilenameFilter] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const { setMediaViewActionStatus, setMediaViewError } = useMediaViewStatus();
  const syncProgress = useLibrarySyncProgress();
  const { peers: discoveredPeers } = usePeerDiscovery();
  const onlinePeerIds = createMemo(
    () => new Set(discoveredPeers().map((peer) => peer.endpoint_id)),
  );
  const ZOOM_LEVELS = [80, 100, 120, 160, 200, 260, 320];
  const [zoomIndex, setZoomIndex] = createSignal(3);
  let isDisposed = false;
  let mediaShellRef: HTMLDivElement | undefined;

  const thumbnailMemoryBuffer = new Map<string, string>();

  const thumbnailBufferKey = (item: MediaItem) =>
    `${mediaItemKey(item)}::snapshot:${item.metadata.latestSnapshotId ?? "none"}::ev:${item.metadata.latestSnapshotCreatedAt ?? "none"}::modified:${item.modifiedAt ?? "none"}`;

  const getBufferedThumbnailSrc = (item: MediaItem) => {
    const key = thumbnailBufferKey(item);
    const url = thumbnailMemoryBuffer.get(key);
    if (!url) {
      return undefined;
    }
    thumbnailMemoryBuffer.delete(key);
    thumbnailMemoryBuffer.set(key, url);
    return url;
  };

  const rememberThumbnailSrc = (item: MediaItem, src: string) => {
    if (!src.startsWith("blob:")) {
      return;
    }
    const key = thumbnailBufferKey(item);
    thumbnailMemoryBuffer.delete(key);
    thumbnailMemoryBuffer.set(key, src);
    while (thumbnailMemoryBuffer.size > THUMBNAIL_MEMORY_BUFFER_SIZE) {
      const oldestKey = thumbnailMemoryBuffer.keys().next().value;
      if (typeof oldestKey !== "string") {
        throw new Error("thumbnail memory buffer is out of sync");
      }
      const oldestSrc = thumbnailMemoryBuffer.get(oldestKey);
      if (!oldestSrc) {
        throw new Error("thumbnail memory buffer entry is missing");
      }
      thumbnailMemoryBuffer.delete(oldestKey);
      if (oldestSrc !== state.loadingMediaSrc) {
        URL.revokeObjectURL(oldestSrc);
      }
    }
  };

  const libraryEntries = createMemo<LibraryEntry[]>(() => libraries() ?? []);
  const selectedLibrary = createMemo(
    () =>
      libraryEntries().find((library) => library.id === selectedLibraryId()) ?? null,
  );
  const activeMediaItemId = createMemo(() =>
    state.activeMediaLibraryId === selectedLibraryId() ? state.activeMediaItemId : null,
  );
  const availableItems = createMemo(() => {
    const current = items();
    if (current?.libraryId === selectedLibraryId()) {
      return current.items;
    }
    return cachedLibraryItems() ?? [];
  });
  const normalizedFilenameFilter = createMemo(() =>
    normalizeFilenameFilter(filenameFilter()),
  );
  const activeFilenameFilter = createMemo(() =>
    state.currentView === "editor" ? [] : normalizedFilenameFilter(),
  );
  const filteredByFilename = createMemo(() =>
    filterMediaItemsByFilename(availableItems(), activeFilenameFilter()),
  );
  const collections = useCollectionMembership({
    selectedLibraryId,
  });
  const displayedItems = createMemo(() => {
    const items = filteredByFilename();
    const fingerprints = collections.collectionItemPaths();
    if (collections.selectedCollectionId() === null || fingerprints.size === 0) {
      return items;
    }
    return items.filter(
      (item) => item.kind === "local" && fingerprints.has(item.fingerprint ?? item.path),
    );
  });
  const flatItemIds = createMemo(() =>
    displayedItems().map((item) => mediaItemKey(item)),
  );
  const itemsById = createMemo(
    () => new Map(displayedItems().map((item) => [mediaItemKey(item), item])),
  );
  const isLibraryScanComplete = createMemo(() => {
    const current = items();
    if (!selectedLibraryId() || selectedLibraryId()?.startsWith("peer:")) {
      return true;
    }
    if (!current || current.libraryId !== selectedLibraryId()) {
      return false;
    }
    return current.isComplete;
  });
  const selectedLibraryDetail = createMemo(() => {
    const library = selectedLibrary();
    if (!library) {
      return "";
    }
    return isPeerLibrary(library) ? peerLibraryPeerId(library) : (library.path ?? "");
  });
  const selectedLibraryIsRefreshing = createMemo(() =>
    isLocalLibraryRefreshing(selectedLibrary()),
  );
  const selectedLibraryIsOffline = createMemo(() =>
    isLibraryOffline(selectedLibrary(), onlinePeerIds()),
  );
  const displayedError = createMemo(() => {
    if (selectedLibraryIsOffline()) {
      return null;
    }
    const current = items();
    if (current && current.libraryId === selectedLibraryId() && current.error) {
      return current.error;
    }
    return error();
  });
  createEffect(() => {
    setMediaViewError(displayedError());
  });
  createEffect(() => {
    setMediaViewActionStatus(mediaActionStatus());
  });
  onCleanup(() => {
    setMediaViewActionStatus(null);
    setMediaViewError(null);
  });
  const hasLibraries = createMemo(() => libraryEntries().length > 0);
  const canWriteSelectedLibrary = createMemo(() => libraryIsWritable(selectedLibrary()));
  const shouldDeferEditorStripThumbnails = createMemo(
    () => state.currentView === "editor" && isS3Library(selectedLibrary()),
  );
  createEffect(() => {
    const availableLibraries = libraryEntries();
    if (!availableLibraries.length) {
      setSelectedLibraryId(null);
      return;
    }
    const current = selectedLibraryId();
    if (current && availableLibraries.some((library) => library.id === current)) {
      return;
    }
    const firstLocalLibrary = availableLibraries.find(
      (library) => !isPeerLibrary(library),
    );
    setSelectedLibraryId(firstLocalLibrary?.id ?? null);
  });

  provideMediaViewStore({
    selectedLibraryId,
    setSelectedLibraryId,
    selectedLibrary,
    libraryEntries,
    flatItemIds,
    itemsById,
    canWriteSelectedLibrary,
    isSubmitting,
    setIsSubmitting,
    setError,
    setMediaActionStatus,
    setShowApplyPresetMenu,
    setZoomIndex,
    zoomLevelCount: ZOOM_LEVELS.length,
    syncProgress,
    pickDirectory,
    deleteMediaLibraryItem,
    uploadMediaLibraryFile,
    uploadMediaLibraryPath,
    uploadMediaLibraryUrl,
    refreshLibraryIndex,
    refetchItems,
    refetchCachedLibraryItems,
    layerOps,
    batchOps,
  });
  const selection = useMediaSelection();
  const selectedCollectionFileHashes = () =>
    selection.selectedMediaItemIds().map((itemId) => {
      const item = itemsById().get(itemId);
      if (!item) {
        throw new Error(`selected media item not found: ${itemId}`);
      }
      if (item.kind !== "local") {
        throw new Error(`collection item is not local: ${itemId}`);
      }
      return item.fingerprint ?? item.path;
    });

  const uploads = useMediaUploadHandlers();
  const itemActions = useMediaItemActions();
  useMediaViewActions({
    toggleMediaSelection: selection.toggleMediaSelection,
    navigateFocus: selection.navigateFocus,
    pasteEdits: itemActions.handleApplyPresetToSelected,
  });

  onMount(() => {
    const libraryRefreshTimer = window.setInterval(() => {
      void Promise.resolve(refetchLibraries()).catch(() => undefined);
      syncSelectedLibraryIfNeeded();
    }, 3000);
    onCleanup(() => {
      isDisposed = true;
      window.clearInterval(libraryRefreshTimer);
      for (const src of thumbnailMemoryBuffer.values()) {
        if (src !== state.loadingMediaSrc) {
          URL.revokeObjectURL(src);
        }
      }
      thumbnailMemoryBuffer.clear();
    });
  });

  createEffect(() => {
    selectedLibraryId();
    actions.run("media.grid.reset-scroll", buildActionContext());
    selection.setSelectedMediaItemIds([]);
  });

  createEffect(() => {
    normalizedFilenameFilter();
    actions.run("media.grid.reset-scroll", buildActionContext());
  });

  createEffect(() => {
    if (state.currentView !== "media" || !selectedLibraryId()) {
      return;
    }
    void refetchCachedLibraryItems();
    void refetchItems();
  });

  // Camera libraries have no event support — poll while incomplete.
  createEffect(() => {
    const library = selectedLibrary();
    if (!library || !isCameraLibrary(library)) {
      return;
    }
    const current = items();
    if (
      items.loading ||
      !current ||
      current.libraryId !== library.id ||
      (current.isComplete && !selectedLibraryIsRefreshing())
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (isDisposed) {
        return;
      }
      void Promise.resolve(refetchItems()).catch((error) => {
        setError(toErrorMessage(error));
      });
    }, 300);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const id = selection.focusedItemId();
    if (!id || !selection.keyboardNavActive()) return;
    actions.run("media.grid.scroll-focused-into-view", buildActionContext());
  });

  async function withSubmitting(fn: () => Promise<void>) {
    if (isSubmitting()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAddLibrary() {
    await withSubmitting(async () => {
      const selectedPath = await pickDirectory();
      if (selectedPath === null) return;
      const library = await addMediaLibrary(selectedPath);
      await refetchLibraries();
      setSelectedLibraryId(library.id);
      await refetchItems();
    });
  }

  function syncSelectedLibraryIfNeeded() {
    const library = selectedLibrary();
    if (!library || library.mode !== "sync" || syncProgress()) {
      return;
    }
    void syncLibrary(library.id).catch((err) => {
      setError(toErrorMessage(err));
    });
  }

  const isEditorStrip = () => state.currentView === "editor";
  const mediaVisibleClass = () =>
    isEditorStrip() ? "flex touch-compact:hidden" : "flex";
  const shellClass = () =>
    isEditorStrip()
      ? "flex w-[112px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel-bg)] touch-compact:hidden"
      : "flex flex-1 flex-col overflow-hidden pt-0 touch-compact:pt-[calc(env(safe-area-inset-top)+3.5rem)]";

  const hasImage = () => state.canvasWidth > 0 || state.isLoading;

  return (
    <section
      ref={mediaShellRef}
      tabIndex={-1}
      aria-label="Media view"
      data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
      class={`${shellClass()} mobile-slider-fade outline-none relative transition-opacity duration-150`}
      onDragEnter={uploads.handleUploadDragEnter}
      onDragOver={uploads.handleUploadDragOver}
      onDragLeave={uploads.handleUploadDragLeave}
      onDrop={uploads.handleUploadDrop}
      onPaste={uploads.handleUploadPaste}
      onPointerDown={(event) => {
        if (targetUsesOwnFocus(event.target)) {
          return;
        }
        mediaShellRef?.focus();
      }}
    >
      <Show when={uploads.isUploadDragActive()}>
        <div class="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border border-dashed border-[var(--border-active)] bg-[color-mix(in_srgb,var(--surface-active)_68%,transparent)]">
          <div class="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-active)] bg-[var(--panel-bg)] px-5 py-4 text-center shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
            <div class="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text)]">
              {uploads.uploadDragLabel()}
            </div>
            <p class="text-[12px] font-medium text-[var(--text-dim)]">
              {selectedLibrary()?.name ?? "Selected library"}
            </p>
          </div>
        </div>
      </Show>
      <Show when={!isEditorStrip()}>
        <div
          class={`${mediaVisibleClass()} border-b border-[var(--border)] px-4 py-4 touch-mobile:px-4`}
        >
          <LibrarySelector
            libraries={libraryEntries()}
            selectedLibraryId={selectedLibraryId()}
            filenameFilter={filenameFilter()}
            zoomIndex={zoomIndex()}
            zoomLevelCount={ZOOM_LEVELS.length}
            onSelectLibrary={setSelectedLibraryId}
            onFilenameFilterInput={setFilenameFilter}
            onZoomOut={() => setZoomIndex((i) => Math.max(0, i - 1))}
            onZoomIn={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
            onLibrariesChanged={refetchLibraries}
            onLibraryItemsChanged={async () => {
              await refetchCachedLibraryItems();
              await refetchItems();
            }}
            onError={setError}
          />
        </div>
      </Show>
      <div
        class="relative flex-1 min-h-0 flex"
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (touch.clientX > 24) return;
          const startX = touch.clientX;
          const startY = touch.clientY;
          let moved = false;
          function onMove(ev: TouchEvent) {
            if (moved) return;
            const dx = ev.touches[0].clientX - startX;
            const dy = Math.abs(ev.touches[0].clientY - startY);
            if (dx > 30 && dy < 50) {
              moved = true;
              collections.setMobileSidebarOpen(true);
            }
          }
          function onEnd() {
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onEnd);
          }
          document.addEventListener("touchmove", onMove, { passive: true });
          document.addEventListener("touchend", onEnd, { once: true });
        }}
      >
        <Show when={!isEditorStrip() && selectedLibrary()}>
          <CollectionSidebar
            collections={collections.collections()}
            selectedCollectionId={collections.selectedCollectionId()}
            totalCount={availableItems().length}
            onSelect={(id) => {
              collections.setSelectedCollectionId(id);
              collections.setMobileSidebarOpen(false);
            }}
            onCreate={() => void collections.handleCreateCollection()}
            onRename={(id, name) => void collections.handleRenameCollection(id, name)}
            onDelete={(id) => void collections.handleDeleteCollection(id)}
            mobileOpen={collections.mobileSidebarOpen()}
            onMobileClose={() => collections.setMobileSidebarOpen(false)}
          />
        </Show>
        <div class="relative flex-1 min-h-0 flex flex-col">
          <Show when={hasImage() && state.currentView === "editor"}>
            <div class="px-2 pt-2 pb-1 w-full flex">
              <ActionButton
                class="w-full"
                label="Back"
                icon={
                  <svg
                    width="24px"
                    height="24px"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    class="h-4 w-4"
                  >
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                }
                onClick={() => {
                  showMediaView();
                }}
              />
            </div>
          </Show>

          <Show
            when={
              !isEditorStrip() && !isLibraryScanComplete() && availableItems().length > 0
            }
          >
            <div class="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-5 py-2 text-[11px] font-medium text-[var(--text-dim)]">
              <div class="h-2.5 w-2.5 animate-spin rounded-full border border-[var(--border-medium)] border-t-[var(--text-muted)]" />
              Indexing · {availableItems().length.toLocaleString()} images found so far
            </div>
          </Show>
          <PictureGrid
            displayedItemCount={displayedItems().length}
            displayedItems={displayedItems()}
            hasLibraries={hasLibraries()}
            isEditorStrip={isEditorStrip()}
            isLibraryScanComplete={isLibraryScanComplete()}
            availableItemCount={availableItems().length}
            selectedLibraryName={selectedLibrary()?.name ?? null}
            selectedLibraryIsOffline={selectedLibraryIsOffline()}
            itemsLoading={items.loading}
            activeFilenameFilterCount={activeFilenameFilter().length}
            filenameFilter={filenameFilter()}
            zoomIndex={zoomIndex()}
            zoomLevels={ZOOM_LEVELS}
            itemById={(id) => itemsById().get(id)}
            getBufferedThumbnailSrc={getBufferedThumbnailSrc}
            shouldDeferEditorStripThumbnails={shouldDeferEditorStripThumbnails()}
            activeMediaItemId={activeMediaItemId()}
            isSelected={(id) => selection.selectedMediaItemIdSet().has(id)}
            isFocused={(id) =>
              selection.keyboardNavActive() && selection.focusedItemId() === id
            }
            showSelectionControls={selection.showSelectionControls()}
            onThumbnailLoaded={rememberThumbnailSrc}
            onActivate={(item, src) => {
              const libraryId = selectedLibraryId();
              if (!libraryId) {
                throw new Error("selected library is required");
              }
              void itemActions.handleOpenItem(item, libraryId, src);
            }}
            onToggleSelection={selection.toggleMediaSelection}
            onShiftSelect={selection.rangeSelectMedia}
            onFocusItem={(id) => {
              selection.setFocusedItemId(id);
              selection.setKeyboardNavActive(false);
            }}
            onAddLibrary={() => void handleAddLibrary()}
            isSubmitting={isSubmitting()}
          />
        </div>
      </div>

      <div
        class={`selection-bar ${isEditorStrip() ? "hidden" : "flex"} flex-col gap-2 border-t border-[var(--border)] px-4 touch-mobile:hidden lg:px-6`}
      >
        <SelectionBar
          selectedCount={selection.selectedMediaItemIds().length}
          isSubmitting={isSubmitting()}
          canWriteSelectedLibrary={canWriteSelectedLibrary()}
          selectedCollectionId={collections.selectedCollectionId()}
          presets={presets() ?? []}
          showApplyPresetMenu={showApplyPresetMenu()}
          showAddToCollectionMenu={collections.showAddToCollectionMenu()}
          collections={collections.collections()}
          onOpenSelected={() => void itemActions.handleOpenSelectedItems()}
          onExportSelected={() => void itemActions.handleExportSelected()}
          onToggleApplyPresetMenu={() => {
            setShowApplyPresetMenu(!showApplyPresetMenu());
            if (!presets()) {
              void refetchPresets();
            }
          }}
          onApplyPreset={(name) => void itemActions.handleApplyPresetToSelected(name)}
          onClearEdits={() => void itemActions.handleClearEditsForSelected()}
          onToggleAddToCollectionMenu={() =>
            collections.setShowAddToCollectionMenu(
              !collections.showAddToCollectionMenu(),
            )
          }
          onAddToCollection={(id) =>
            void collections.handleAddToCollection(id, selectedCollectionFileHashes())
          }
          onCreateAndAddToCollection={() =>
            void collections.handleCreateAndAddToCollection(
              selectedCollectionFileHashes(),
            )
          }
          onRemoveFromCollection={() =>
            void collections
              .handleRemoveFromCollection(selectedCollectionFileHashes())
              .then(() => selection.setSelectedMediaItemIds([]))
          }
          onDeleteSelected={() => void itemActions.handleDeleteSelectedItems()}
          onClearSelection={() => {
            selection.setSelectedMediaItemIds([]);
            setShowApplyPresetMenu(false);
            setMediaActionStatus(null);
          }}
        />
      </div>

      <Show when={selectedLibrary()}>
        <div class="fixed bottom-[env(safe-area-inset-bottom)] left-0 right-0 hidden w-auto px-2 pb-2 touch-mobile:block">
          <input
            type="text"
            value={filenameFilter()}
            onInput={(event) => setFilenameFilter(event.currentTarget.value)}
            class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            placeholder="Search names or tags"
            aria-label="Search names or tags"
          />
        </div>
      </Show>

    </section>
  );
};
