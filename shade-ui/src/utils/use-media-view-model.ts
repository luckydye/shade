import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { provideCollectionMembershipStore } from "../components/media-view/collection-membership-store";
import { provideMediaSelectionStore } from "../components/media-view/media-selection-store";
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
} from "../components/media-view/media-utils";
import { provideMediaViewStore } from "../components/media-view/media-view-store";
import { actions, buildActionContext } from "../store/actions";
import { state } from "../store/editor-store";
import { useBatchOperations } from "./use-batch-operations";
import { useCollectionMembership } from "./use-collection-membership";
import { useLayerStack } from "./use-layer-stack";
import { useLibraryItems } from "./use-library-items";
import { useLibrarySyncProgress } from "./use-library-sync-progress";
import { useMediaItemActions } from "./use-media-item-actions";
import { useMediaLibraryList } from "./use-media-library-list";
import { useMediaSelection } from "./use-media-selection";
import { useMediaViewActions } from "./use-media-view-actions";
import { useMediaViewStatus } from "./use-media-view-status";
import { usePeerDiscovery } from "./use-peer-discovery";
import { usePresetList } from "./use-preset-list";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaViewModel() {
  const layerOps = useLayerStack();
  const batchOps = useBatchOperations();
  const {
    libraries,
    refetch: refetchLibraries,
    refreshLibraryIndex,
    syncLibrary,
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
  let isDisposed = false;

  const libraryEntries = createMemo<LibraryEntry[]>(() => libraries() ?? []);
  const selectedLibrary = createMemo(
    () => libraryEntries().find((library) => library.id === selectedLibraryId()) ?? null,
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
  provideCollectionMembershipStore(collections);
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
  const hasLibraries = createMemo(() => libraryEntries().length > 0);
  const canWriteSelectedLibrary = createMemo(() => libraryIsWritable(selectedLibrary()));
  const shouldDeferEditorStripThumbnails = createMemo(
    () => state.currentView === "editor" && isS3Library(selectedLibrary()),
  );

  const libraryStore = {
    selectedLibraryId,
    setSelectedLibraryId,
    selectedLibrary,
    libraryEntries,
    refetchLibraries,
    hasLibraries,
    selectedLibraryIsOffline,
    canWriteSelectedLibrary,
    shouldDeferEditorStripThumbnails,
  };
  const mediaItemsStore = {
    activeFilenameFilter,
    activeMediaItemId,
    availableItemCount: () => availableItems().length,
    displayedItems,
    flatItemIds,
    isLibraryScanComplete,
    itemsLoading: () => items.loading,
    itemsById,
    refetchItems,
  };
  const mediaUiStore = {
    filenameFilter,
    setFilenameFilter,
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
    deleteMediaLibraryItem,
    uploadMediaLibraryFile,
    uploadMediaLibraryPath,
    uploadMediaLibraryUrl,
    refreshLibraryIndex,
  };

  provideMediaViewStore({
    ...libraryStore,
    ...mediaItemsStore,
    ...mediaUiStore,
    ...presetStore,
    ...mediaLibraryActions,
    layerOps,
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

  function syncSelectedLibraryIfNeeded() {
    const library = selectedLibrary();
    if (!library || library.mode !== "sync" || syncProgress()) {
      return;
    }
    void syncLibrary(library.id).catch((err) => {
      setError(toErrorMessage(err));
    });
  }

  onMount(() => {
    const libraryRefreshTimer = window.setInterval(() => {
      void Promise.resolve(refetchLibraries()).catch(() => undefined);
      syncSelectedLibraryIfNeeded();
    }, 3000);
    onCleanup(() => {
      isDisposed = true;
      window.clearInterval(libraryRefreshTimer);
    });
  });

  createEffect(() => {
    selectedLibraryId();
    // actions.run("media.grid.reset-scroll", buildActionContext());
    selection.setSelectedMediaItemIds([]);
  });

  createEffect(() => {
    normalizedFilenameFilter();
    // actions.run("media.grid.reset-scroll", buildActionContext());
  });

  createEffect(() => {
    if (state.currentView !== "media" || !selectedLibraryId()) {
      return;
    }
    void refetchItems();
  });

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

  return {
    availableItems,
    collections,
    isLibraryScanComplete,
    selectedLibrary,
  };
}
