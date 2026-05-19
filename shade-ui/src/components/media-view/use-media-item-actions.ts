import type { Accessor, Setter } from "solid-js";
import type { MediaItem } from "../../data/use-library-items";
import { useOpenImage } from "../../store/use-open-image";
import { isTauriRuntime } from "../../utils";
import { libraryIsWritable, openMediaItem, type LibraryEntry } from "./media-utils";

type LocalMediaItem = Extract<MediaItem, { kind: "local" }>;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaItemActions(params: {
  selectedLibraryId: Accessor<string | null>;
  selectedMediaItemIds: Accessor<string[]>;
  setSelectedMediaItemIds: Setter<string[]>;
  itemsById: Accessor<Map<string, MediaItem>>;
  canWriteSelectedLibrary: Accessor<boolean>;
  setShowApplyPresetMenu: Setter<boolean>;
  setIsSubmitting: Setter<boolean>;
  setError: Setter<string | null>;
  setMediaActionStatus: Setter<string | null>;
  pickDirectory: () => Promise<string | null>;
  deleteMediaLibraryItem: (path: string) => Promise<unknown>;
  refetchItems: () => unknown;
  refetchCachedLibraryItems: () => unknown;
  layerOps: {
    applyPresetSnapshot: (name: string, path: string | null) => Promise<unknown>;
  };
  batchOps: {
    applyPresetSnapshot: (
      items: { path: string; fingerprint: string | null }[],
      name: string,
    ) => Promise<number>;
    clearEdits: (paths: string[]) => Promise<number>;
    exportImages: (
      items: { path: string; fingerprint: string | null; name: string }[],
      targetDir: string,
    ) => Promise<number>;
  };
}) {
  const selectedItems = () =>
    params
      .selectedMediaItemIds()
      .map((id) => params.itemsById().get(id))
      .filter(Boolean) as MediaItem[];

  async function handleOpenItem(item: MediaItem, libraryId: string, src: string | null) {
    params.setSelectedMediaItemIds([]);
    params.setError(null);
    try {
      await openMediaItem(item, libraryId, src);
    } catch (err) {
      params.setError(toErrorMessage(err));
    }
  }

  async function handleOpenSelectedItems() {
    const libraryId = params.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot open selected media without a library");
    }
    const itemIds = params.selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    params.setError(null);
    try {
      for (const [index, itemId] of itemIds.entries()) {
        const item = params.itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        await openMediaItem(item, libraryId, null, index === 0 ? "replace" : "append");
      }
    } catch (err) {
      params.setError(toErrorMessage(err));
    }
  }

  async function handleApplyPresetToSelected(name: string) {
    const libraryId = params.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot apply a preset without a selected library");
    }
    const itemIds = params.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to apply a preset");
    }
    params.setShowApplyPresetMenu(false);
    params.setIsSubmitting(true);
    params.setError(null);
    params.setMediaActionStatus(
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
        const count = await params.batchOps.applyPresetSnapshot(batchItems, name);
        params.setMediaActionStatus(
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
            await params.layerOps.applyPresetSnapshot(name, null);
          } else {
            await useOpenImage().open(item.path);
            await params.layerOps.applyPresetSnapshot(name, item.path);
          }
          params.setMediaActionStatus(
            `Applying ${name}... (${index + 1}/${items.length})`,
          );
        }
        params.setMediaActionStatus(
          `Applied ${name} and saved ${items.length} snapshot${items.length > 1 ? "s" : ""}`,
        );
      }
      await Promise.all([params.refetchItems(), params.refetchCachedLibraryItems()]);
    } catch (err) {
      params.setError(toErrorMessage(err));
      params.setMediaActionStatus(null);
    } finally {
      params.setIsSubmitting(false);
    }
  }

  async function handleClearEditsForSelected() {
    const libraryId = params.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot clear edits without a selected library");
    }
    const itemIds = params.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to clear edits");
    }
    params.setShowApplyPresetMenu(false);
    params.setIsSubmitting(true);
    params.setError(null);
    params.setMediaActionStatus(
      `Clearing edits for ${itemIds.length} image${itemIds.length > 1 ? "s" : ""}...`,
    );
    try {
      const items = selectedItems();
      const isTauri = isTauriRuntime();
      if (isTauri) {
        const paths = items.flatMap((item) => (item.kind === "local" ? [item.path] : []));
        const count = await params.batchOps.clearEdits(paths);
        params.setMediaActionStatus(
          `Cleared edits for ${count} image${count > 1 ? "s" : ""}`,
        );
      } else {
        params.setMediaActionStatus("Clear edits is only supported in the native app");
      }
      await Promise.all([params.refetchItems(), params.refetchCachedLibraryItems()]);
    } catch (err) {
      params.setError(toErrorMessage(err));
      params.setMediaActionStatus(null);
    } finally {
      params.setIsSubmitting(false);
    }
  }

  async function handleDeleteSelectedItems() {
    if (!params.canWriteSelectedLibrary()) {
      throw new Error("selected library is readonly");
    }
    const itemIds = params.selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    params.setIsSubmitting(true);
    params.setError(null);
    try {
      for (const itemId of itemIds) {
        const item = params.itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        if (item.kind !== "local") {
          throw new Error(`media item is not deletable: ${itemId}`);
        }
        await params.deleteMediaLibraryItem(item.path);
      }
      params.setSelectedMediaItemIds([]);
      await params.refetchCachedLibraryItems();
      await params.refetchItems();
    } catch (err) {
      params.setError(toErrorMessage(err));
    } finally {
      params.setIsSubmitting(false);
    }
  }

  async function handleExportSelected() {
    const libraryId = params.selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot export without a selected library");
    }
    const itemIds = params.selectedMediaItemIds();
    if (itemIds.length === 0) {
      throw new Error("select at least one image to export");
    }
    const targetDir = await params.pickDirectory();
    if (!targetDir || typeof targetDir !== "string") {
      return;
    }
    params.setIsSubmitting(true);
    params.setError(null);
    params.setMediaActionStatus(
      `Exporting ${itemIds.length} image${itemIds.length > 1 ? "s" : ""}...`,
    );
    try {
      const localItems = selectedItems().filter((item) => item.kind === "local");
      if (localItems.length === 0) {
        throw new Error("export is only supported for local images");
      }
      const isTauri = isTauriRuntime();
      if (!isTauri) {
        params.setMediaActionStatus("Export is only supported in the native app");
        return;
      }
      const batchItems = localItems.map((item) => ({
        path: item.path,
        fingerprint: item.fingerprint,
        name: item.name,
      }));
      const count = await params.batchOps.exportImages(batchItems, targetDir);
      params.setMediaActionStatus(
        `Exported ${count} image${count > 1 ? "s" : ""} to ${targetDir}`,
      );
    } catch (err) {
      params.setError(toErrorMessage(err));
      params.setMediaActionStatus(null);
    } finally {
      params.setIsSubmitting(false);
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
