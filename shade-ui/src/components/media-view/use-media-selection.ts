import type { Accessor, Setter } from "solid-js";
import { createEffect, createMemo, createSignal } from "solid-js";
import type { MediaItem } from "../../data/use-library-items";
import {
  setMediaViewFocusedItem,
  setMediaViewFocusedItemId,
  setMediaViewSelectedBatchItems,
  setMediaViewSelectedItemIds,
  setMediaViewSelectedLibraryId,
} from "../../store/media-view-context";
import { mediaItemKey, type MediaGridRow } from "./media-utils";

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

export function useMediaSelection(params: {
  selectedLibraryId: Accessor<string | null>;
  flatItemIds: Accessor<string[]>;
  itemsById: Accessor<Map<string, MediaItem>>;
  gridRows: Accessor<MediaGridRow[]>;
  columns: Accessor<number>;
  onActionStatus: Setter<string | null>;
}) {
  const [selectedMediaItemIds, setSelectedMediaItemIds] = createSignal<string[]>([]);
  const [lastSelectedMediaItemId, setLastSelectedMediaItemId] = createSignal<
    string | null
  >(null);
  const [keyboardNavActive, setKeyboardNavActive] = createSignal(false);
  const [focusedItemId, setFocusedItemId] = createSignal<string | null>(null);

  const selectedMediaItemIdSet = createMemo(() => new Set(selectedMediaItemIds()));
  const showSelectionControls = createMemo(() => selectedMediaItemIds().length > 0);

  const clearSelection = () => {
    setSelectedMediaItemIds([]);
    params.onActionStatus(null);
  };

  const toggleMediaSelection = (itemId: string) => {
    setLastSelectedMediaItemId(itemId);
    params.onActionStatus(null);
    setSelectedMediaItemIds((current) =>
      current.includes(itemId)
        ? current.filter((candidate) => candidate !== itemId)
        : [...current, itemId],
    );
  };

  const rangeSelectMedia = (itemId: string) => {
    const lastId = lastSelectedMediaItemId();
    const allIds = params
      .gridRows()
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
    setSelectedMediaItemIds((current) => {
      const result = new Set(current);
      for (const id of rangeIds) result.add(id);
      return [...result];
    });
    params.onActionStatus(null);
    setLastSelectedMediaItemId(itemId);
  };

  const navigateFocus = (direction: "left" | "right" | "up" | "down") => {
    const ids = params.flatItemIds();
    if (ids.length === 0) return;
    let index = focusedItemId() ? ids.indexOf(focusedItemId()!) : -1;
    if (index === -1) {
      setFocusedItemId(ids[0]);
      return;
    }
    const colCount = params.columns();
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
      setFocusedItemId(ids[index]);
    }
  };

  createEffect(() => {
    setMediaViewFocusedItemId(focusedItemId());
    const id = focusedItemId();
    const item = id ? params.itemsById().get(id) : undefined;
    setMediaViewFocusedItem(item ? mediaItemToBatchItem(item) : null);
  });

  createEffect(() => {
    setMediaViewSelectedItemIds(selectedMediaItemIds());
  });

  createEffect(() => {
    setMediaViewSelectedLibraryId(params.selectedLibraryId());
  });

  createEffect(() => {
    const byId = params.itemsById();
    const batchItems = selectedMediaItemIds()
      .map((id) => byId.get(id))
      .filter((item): item is MediaItem => !!item)
      .map(mediaItemToBatchItem);
    setMediaViewSelectedBatchItems(batchItems);
  });

  createEffect(() => {
    const availableItemIds = new Set(params.flatItemIds());
    setSelectedMediaItemIds((current) => {
      const next = current.filter((id) => availableItemIds.has(id));
      return next.length === current.length ? current : next;
    });
  });

  createEffect(() => {
    const id = focusedItemId();
    if (!id) return;
    const ids = new Set(params.flatItemIds());
    if (!ids.has(id)) {
      setFocusedItemId(null);
    }
  });

  return {
    selectedMediaItemIds,
    setSelectedMediaItemIds,
    selectedMediaItemIdSet,
    showSelectionControls,
    keyboardNavActive,
    setKeyboardNavActive,
    focusedItemId,
    setFocusedItemId,
    clearSelection,
    toggleMediaSelection,
    rangeSelectMedia,
    navigateFocus,
  };
}
