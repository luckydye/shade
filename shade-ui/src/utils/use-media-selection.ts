import { createEffect, createMemo, createSignal } from "solid-js";
import { type MediaGridRow, mediaItemKey } from "../components/media-view/media-utils";
import { useMediaViewStore } from "../components/media-view/media-view-store";
import {
  pictureGridColumns,
  pictureGridRows,
} from "../components/media-view/picture-grid-state";
import {
  setMediaViewFocusedItem,
  setMediaViewFocusedItemId,
  setMediaViewSelectedBatchItems,
  setMediaViewSelectedItemIds,
  setMediaViewSelectedLibraryId,
} from "../store/media-view-context";
import type { MediaItem } from "./use-library-items";

function mediaItemToBatchItem(item: MediaItem) {
  return item.kind === "peer"
    ? {
        path: item.name,
        fingerprint: item.fingerprint,
        kind: "peer" as const,
        peerId: item.peerId,
        id: item.id,
      }
    : { path: item.path, fingerprint: item.fingerprint, kind: "local" as const };
}

export function useMediaSelection() {
  const store = useMediaViewStore();
  const [lastSelectedMediaItemId, setLastSelectedMediaItemId] = createSignal<
    string | null
  >(null);

  const selectedMediaItemIdSet = createMemo(() => new Set(store.selectedMediaItemIds()));
  const showSelectionControls = createMemo(() => store.selectedMediaItemIds().length > 0);

  const clearSelection = () => {
    store.setSelectedMediaItemIds([]);
    store.setMediaActionStatus(null);
  };

  const toggleMediaSelection = (itemId: string) => {
    setLastSelectedMediaItemId(itemId);
    store.setMediaActionStatus(null);
    store.setSelectedMediaItemIds((current) =>
      current.includes(itemId)
        ? current.filter((candidate) => candidate !== itemId)
        : [...current, itemId],
    );
  };

  const rangeSelectMedia = (itemId: string) => {
    const lastId = lastSelectedMediaItemId();
    const allIds = pictureGridRows()
      .filter(
        (row): row is Extract<MediaGridRow, { kind: "items" }> => row.kind === "items",
      )
      .flatMap((row) => row.ids);
    const fromIndex = lastId != null ? allIds.indexOf(lastId) : -1;
    const toIndex = allIds.indexOf(itemId);
    if (fromIndex === -1 || toIndex === -1) {
      toggleMediaSelection(itemId);
      return;
    }
    const [start, end] =
      fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    const rangeIds = allIds.slice(start, end + 1);
    store.setSelectedMediaItemIds((current) => {
      const result = new Set(current);
      for (const id of rangeIds) result.add(id);
      return [...result];
    });
    store.setMediaActionStatus(null);
    setLastSelectedMediaItemId(itemId);
  };

  const navigateFocus = (direction: "left" | "right" | "up" | "down") => {
    const ids = store.flatItemIds();
    if (ids.length === 0) return;
    let index = store.focusedItemId() ? ids.indexOf(store.focusedItemId()!) : -1;
    if (index === -1) {
      store.setFocusedItemId(ids[0]);
      return;
    }
    const colCount = pictureGridColumns();
    switch (direction) {
      case "left":
        index -= 1;
        break;
      case "right":
        index += 1;
        break;
      case "up":
        index -= colCount;
        break;
      case "down":
        index += colCount;
        break;
    }
    if (index >= 0 && index < ids.length) {
      store.setFocusedItemId(ids[index]);
    }
  };

  createEffect(() => {
    setMediaViewFocusedItemId(store.focusedItemId());
    const id = store.focusedItemId();
    const item = id ? store.itemsById().get(id) : undefined;
    setMediaViewFocusedItem(item ? mediaItemToBatchItem(item) : null);
  });

  createEffect(() => {
    setMediaViewSelectedItemIds(store.selectedMediaItemIds());
  });

  createEffect(() => {
    setMediaViewSelectedLibraryId(store.selectedLibraryId());
  });

  createEffect(() => {
    const byId = store.itemsById();
    const batchItems = store
      .selectedMediaItemIds()
      .map((id) => byId.get(id))
      .filter((item): item is MediaItem => !!item)
      .map(mediaItemToBatchItem);
    setMediaViewSelectedBatchItems(batchItems);
  });

  createEffect(() => {
    const availableItemIds = new Set(store.flatItemIds());
    store.setSelectedMediaItemIds((current) => {
      const next = current.filter((id) => availableItemIds.has(id));
      return next.length === current.length ? current : next;
    });
  });

  createEffect(() => {
    const id = store.focusedItemId();
    if (!id) return;
    const ids = new Set(store.flatItemIds());
    if (!ids.has(id)) {
      store.setFocusedItemId(null);
    }
  });

  return {
    selectedMediaItemIds: store.selectedMediaItemIds,
    setSelectedMediaItemIds: store.setSelectedMediaItemIds,
    selectedMediaItemIdSet,
    showSelectionControls,
    keyboardNavActive: store.keyboardNavActive,
    setKeyboardNavActive: store.setKeyboardNavActive,
    focusedItemId: store.focusedItemId,
    setFocusedItemId: store.setFocusedItemId,
    clearSelection,
    toggleMediaSelection,
    rangeSelectMedia,
    navigateFocus,
  };
}
