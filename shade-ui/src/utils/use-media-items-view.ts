import { type Accessor, createMemo, createSignal } from "solid-js";
import {
  filterMediaItemsByFilename,
  mediaItemKey,
  normalizeFilenameFilter,
} from "../components/media-view/media-utils";
import { state } from "./editor-store";
import { useLibraryItems } from "./use-library-items";

type CollectionFilter = {
  selectedCollectionId: Accessor<string | null>;
  collectionItemPaths: Accessor<Set<string>>;
};

export function useMediaItemsView(params: {
  selectedLibraryId: Accessor<string | null>;
  collections: CollectionFilter;
}) {
  const {
    items,
    cached: cachedLibraryItems,
    refetch: refetchLibraryItems,
    deleteMediaLibraryItem,
    uploadMediaLibraryFile,
    uploadMediaLibraryPath,
    uploadMediaLibraryUrl,
  } = useLibraryItems(params.selectedLibraryId);
  const refetchItems = () => refetchLibraryItems();
  const [filenameFilter, setFilenameFilter] = createSignal("");

  const activeMediaItemId = createMemo(() =>
    state.activeMediaLibraryId === params.selectedLibraryId()
      ? state.activeMediaItemId
      : null,
  );
  const availableItems = createMemo(() => {
    const current = items();
    if (current?.libraryId === params.selectedLibraryId()) {
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
  const displayedItems = createMemo(() => {
    const items = filteredByFilename();
    const fingerprints = params.collections.collectionItemPaths();
    if (
      params.collections.selectedCollectionId() === null ||
      fingerprints.size === 0
    ) {
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
    const selectedLibraryId = params.selectedLibraryId();
    const current = items();
    if (!selectedLibraryId || selectedLibraryId.startsWith("peer:")) {
      return true;
    }
    if (!current || current.libraryId !== selectedLibraryId) {
      return false;
    }
    return current.isComplete;
  });

  return {
    items,
    activeFilenameFilter,
    activeMediaItemId,
    availableItemCount: () => availableItems().length,
    displayedItems,
    filenameFilter,
    setFilenameFilter,
    flatItemIds,
    isLibraryScanComplete,
    itemsLoading: () => items.loading,
    itemsById,
    normalizedFilenameFilter,
    refetchItems,
    deleteMediaLibraryItem,
    uploadMediaLibraryFile,
    uploadMediaLibraryPath,
    uploadMediaLibraryUrl,
  };
}
