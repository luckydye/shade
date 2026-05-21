import { createMemo, createSignal } from "solid-js";
import { provideMediaViewStore } from "./media-view-store";
import { useBatchOperations } from "./use-batch-operations";
import {
  provideCollectionMembershipStore,
  useCollectionMembership,
} from "./use-collection-membership";
import { useLibrarySyncProgress } from "./use-library-sync-progress";
import { useMediaItemsView } from "./use-media-items-view";
import { useMediaItemActions } from "./use-media-item-actions";
import { useMediaLibraryState } from "./use-media-library-state";
import {
  provideMediaSelectionStore,
  useMediaSelection,
} from "./use-media-selection";
import { useMediaViewEffects } from "./use-media-view-effects";
import { useMediaViewActions } from "./use-media-view-actions";
import { useMediaViewStatusSync } from "./use-media-view-status-sync";
import { usePresetList } from "./use-preset-list";

export function useMediaViewModel() {
  const batchOps = useBatchOperations();
  const library = useMediaLibraryState();
  const { presets, refetch: refetchPresets } = usePresetList();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [showApplyPresetMenu, setShowApplyPresetMenu] = createSignal(false);
  const [mediaActionStatus, setMediaActionStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const syncProgress = useLibrarySyncProgress();

  const collections = useCollectionMembership({
    selectedLibraryId: library.selectedLibraryId,
  });
  provideCollectionMembershipStore(collections);
  const mediaItems = useMediaItemsView({
    selectedLibraryId: library.selectedLibraryId,
    collections,
  });
  const displayedError = createMemo(() => {
    if (library.selectedLibraryIsOffline()) {
      return null;
    }
    const current = mediaItems.items();
    if (
      current &&
      current.libraryId === library.selectedLibraryId() &&
      current.error
    ) {
      return current.error;
    }
    return error();
  });

  const libraryStore = {
    selectedLibraryId: library.selectedLibraryId,
    setSelectedLibraryId: library.setSelectedLibraryId,
    selectedLibrary: library.selectedLibrary,
    libraryEntries: library.libraryEntries,
    refetchLibraries: library.refetchLibraries,
    hasLibraries: library.hasLibraries,
    selectedLibraryIsOffline: library.selectedLibraryIsOffline,
    canWriteSelectedLibrary: library.canWriteSelectedLibrary,
    shouldDeferEditorStripThumbnails: library.shouldDeferEditorStripThumbnails,
  };
  const mediaItemsStore = {
    activeFilenameFilter: mediaItems.activeFilenameFilter,
    activeMediaItemId: mediaItems.activeMediaItemId,
    availableItemCount: mediaItems.availableItemCount,
    displayedItems: mediaItems.displayedItems,
    flatItemIds: mediaItems.flatItemIds,
    isLibraryScanComplete: mediaItems.isLibraryScanComplete,
    itemsLoading: mediaItems.itemsLoading,
    itemsById: mediaItems.itemsById,
    refetchItems: mediaItems.refetchItems,
  };
  const mediaUiStore = {
    filenameFilter: mediaItems.filenameFilter,
    setFilenameFilter: mediaItems.setFilenameFilter,
    isSubmitting,
    setIsSubmitting,
    showApplyPresetMenu,
    setError,
    setMediaActionStatus,
    setShowApplyPresetMenu,
  };
  const presetStore = {
    presets,
    refetchPresets,
  };
  const mediaLibraryActions = {
    deleteMediaLibraryItem: mediaItems.deleteMediaLibraryItem,
    uploadMediaLibraryFile: mediaItems.uploadMediaLibraryFile,
    uploadMediaLibraryPath: mediaItems.uploadMediaLibraryPath,
    uploadMediaLibraryUrl: mediaItems.uploadMediaLibraryUrl,
    refreshLibraryIndex: library.refreshLibraryIndex,
  };

  provideMediaViewStore({
    ...libraryStore,
    ...mediaItemsStore,
    ...mediaUiStore,
    ...presetStore,
    ...mediaLibraryActions,
    batchOps,
  });

  const selection = useMediaSelection();
  provideMediaSelectionStore(selection);
  const itemActions = useMediaItemActions();
  useMediaViewActions({
    toggleMediaSelection: selection.toggleMediaSelection,
    navigateFocus: selection.navigateFocus,
    pasteEdits: itemActions.handleApplyPresetToSelected,
  });

  useMediaViewStatusSync({
    displayedError,
    mediaActionStatus,
  });
  useMediaViewEffects({
    selectedLibraryId: library.selectedLibraryId,
    selectedLibrary: library.selectedLibrary,
    selectedLibraryIsRefreshing: library.selectedLibraryIsRefreshing,
    items: mediaItems.items,
    normalizedFilenameFilter: mediaItems.normalizedFilenameFilter,
    refetchItems: mediaItems.refetchItems,
    refetchLibraries: library.refetchLibraries,
    syncLibrary: library.syncLibrary,
    syncProgress,
    setError,
    selection,
  });

}
