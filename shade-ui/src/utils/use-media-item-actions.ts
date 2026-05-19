import type { MediaItem } from "./use-library-items";
import { useOpenImage } from "./use-open-image";
import { isTauriRuntime } from "../utils";
import { openMediaItem } from "../components/media-view/media-utils";
import { useMediaViewStore } from "../components/media-view/media-view-store";

type LocalMediaItem = Extract<MediaItem, { kind: "local" }>;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaItemActions() {
  const store = useMediaViewStore();
  const selectedItems = () =>
    store
      .selectedMediaItemIds()
      .map((id) => store.itemsById().get(id))
      .filter(Boolean) as MediaItem[];

  async function handleOpenItem(item: MediaItem, libraryId: string, src: string | null) {
    store.setSelectedMediaItemIds([]);
    store.setError(null);
    try {
      await openMediaItem(item, libraryId, src);
    } catch (err) {
      store.setError(toErrorMessage(err));
    }
  }

  async function handleOpenSelectedItems() {
    const libraryId = store.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot open selected media without a library");
    }
    const itemIds = store.selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    store.setError(null);
    try {
      for (const [index, itemId] of itemIds.entries()) {
        const item = store.itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        await openMediaItem(item, libraryId, null, index === 0 ? "replace" : "append");
      }
    } catch (err) {
      store.setError(toErrorMessage(err));
    }
  }

  async function handleApplyPresetToSelected(name: string) {
    const libraryId = store.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot apply a preset without a selected library");
    }
    const itemIds = store.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to apply a preset");
    }
    store.setShowApplyPresetMenu(false);
    store.setIsSubmitting(true);
    store.setError(null);
    store.setMediaActionStatus(
      `Applying ${name} to ${itemIds.length} image${itemIds.length > 1 ? "s" : ""}...`,
    );
    try {
      const items = selectedItems();
      const hasPeer = items.some((item) => item.kind === "peer");
      const isTauri = isTauriRuntime();
      if (isTauri && !hasPeer) {
        const localItems = items.filter(
          (item): item is LocalMediaItem => item.kind === "local",
        );
        const batchItems = localItems.map((item) => ({
          path: item.path,
          fingerprint: item.fingerprint,
        }));
        const count = await store.batchOps.applyPresetSnapshot(batchItems, name);
        store.setMediaActionStatus(
          `Applied ${name} and saved ${count} snapshot${count > 1 ? "s" : ""}`,
        );
      } else {
        for (const [index, item] of items.entries()) {
          if (item.kind === "peer") {
            const picture = {
              id: item.id,
              name: item.name,
              modified_at: item.modifiedAt,
              has_snapshots: item.metadata.hasSnapshots,
              latest_snapshot_id: item.metadata.latestSnapshotId,
            };
            await useOpenImage().openPeer(item.peerId, picture);
            await store.layerOps.applyPresetSnapshot(name, null);
          } else {
            await useOpenImage().open(item.path);
            await store.layerOps.applyPresetSnapshot(name, item.path);
          }
          store.setMediaActionStatus(
            `Applying ${name}... (${index + 1}/${items.length})`,
          );
        }
        store.setMediaActionStatus(
          `Applied ${name} and saved ${items.length} snapshot${items.length > 1 ? "s" : ""}`,
        );
      }
      await Promise.all([store.refetchItems(), store.refetchCachedLibraryItems()]);
    } catch (err) {
      store.setError(toErrorMessage(err));
      store.setMediaActionStatus(null);
    } finally {
      store.setIsSubmitting(false);
    }
  }

  async function handleClearEditsForSelected() {
    const libraryId = store.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot clear edits without a selected library");
    }
    const itemIds = store.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to clear edits");
    }
    store.setShowApplyPresetMenu(false);
    store.setIsSubmitting(true);
    store.setError(null);
    store.setMediaActionStatus(
      `Clearing edits for ${itemIds.length} image${itemIds.length > 1 ? "s" : ""}...`,
    );
    try {
      const items = selectedItems();
      const isTauri = isTauriRuntime();
      if (isTauri) {
        const paths = items.flatMap((item) => (item.kind === "local" ? [item.path] : []));
        const count = await store.batchOps.clearEdits(paths);
        store.setMediaActionStatus(
          `Cleared edits for ${count} image${count > 1 ? "s" : ""}`,
        );
      } else {
        store.setMediaActionStatus("Clear edits is only supported in the native app");
      }
      await Promise.all([store.refetchItems(), store.refetchCachedLibraryItems()]);
    } catch (err) {
      store.setError(toErrorMessage(err));
      store.setMediaActionStatus(null);
    } finally {
      store.setIsSubmitting(false);
    }
  }

  async function handleDeleteSelectedItems() {
    if (!store.canWriteSelectedLibrary()) {
      throw new Error("selected library is readonly");
    }
    const itemIds = store.selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    store.setIsSubmitting(true);
    store.setError(null);
    try {
      for (const itemId of itemIds) {
        const item = store.itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        if (item.kind !== "local") {
          throw new Error(`media item is not deletable: ${itemId}`);
        }
        await store.deleteMediaLibraryItem(item.path);
      }
      store.setSelectedMediaItemIds([]);
      await store.refetchCachedLibraryItems();
      await store.refetchItems();
    } catch (err) {
      store.setError(toErrorMessage(err));
    } finally {
      store.setIsSubmitting(false);
    }
  }

  async function handleExportSelected() {
    const libraryId = store.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot export without a selected library");
    }
    const itemIds = store.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to export");
    }
    const targetDir = await store.pickDirectory();
    if (!targetDir || typeof targetDir !== "string") {
      return;
    }
    store.setIsSubmitting(true);
    store.setError(null);
    store.setMediaActionStatus(
      `Exporting ${itemIds.length} image${itemIds.length > 1 ? "s" : ""}...`,
    );
    try {
      const localItems = selectedItems().filter((item) => item.kind === "local");
      if (localItems.length === 0) {
        throw new Error("export is only supported for local images");
      }
      const isTauri = isTauriRuntime();
      if (!isTauri) {
        store.setMediaActionStatus("Export is only supported in the native app");
        return;
      }
      const batchItems = localItems.map((item) => ({
        path: item.path,
        fingerprint: item.fingerprint,
        name: item.name,
      }));
      const count = await store.batchOps.exportImages(batchItems, targetDir);
      store.setMediaActionStatus(
        `Exported ${count} image${count > 1 ? "s" : ""} to ${targetDir}`,
      );
    } catch (err) {
      store.setError(toErrorMessage(err));
      store.setMediaActionStatus(null);
    } finally {
      store.setIsSubmitting(false);
    }
  }

  return {
    handleOpenItem,
    handleOpenSelectedItems,
    handleApplyPresetToSelected,
    handleClearEditsForSelected,
    handleDeleteSelectedItems,
    handleExportSelected,
  };
}
