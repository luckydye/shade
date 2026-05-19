import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal, on } from "solid-js";
import { useCollectionItems } from "../../data/use-collection-items";
import { useCollectionList } from "../../data/use-collection-list";

export function useCollectionMembership(params: {
  selectedLibraryId: Accessor<string | null>;
}) {
  const [selectedCollectionId, setSelectedCollectionId] = createSignal<string | null>(
    null,
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false);
  const [showAddToCollectionMenu, setShowAddToCollectionMenu] = createSignal(false);
  const {
    collections: collectionList,
    refetch: refetchCollections,
    createCollection,
    deleteCollection,
    renameCollection,
  } = useCollectionList(params.selectedLibraryId);
  const collections = () => collectionList() ?? [];
  const {
    items: collectionItemList,
    refetch: refetchCollectionItemsRaw,
    addToCollection,
    removeFromCollection,
  } = useCollectionItems(selectedCollectionId);
  const collectionItemPaths = createMemo(
    () => new Set((collectionItemList() ?? []).map((i) => i.fingerprint)),
  );
  const refreshCollections = refetchCollections;
  const refreshCollectionItems = refetchCollectionItemsRaw;

  async function handleCreateCollection() {
    const libId = params.selectedLibraryId();
    if (!libId) return;
    const col = await createCollection(libId, "Untitled");
    await refreshCollections();
    setSelectedCollectionId(col.id);
  }

  async function handleRenameCollection(id: string, name: string) {
    await renameCollection(id, name);
    await refreshCollections();
  }

  async function handleDeleteCollection(id: string) {
    await deleteCollection(id);
    if (selectedCollectionId() === id) {
      setSelectedCollectionId(null);
    }
    await refreshCollections();
  }

  async function handleAddToCollection(collectionId: string, fingerprints: string[]) {
    if (fingerprints.length === 0) return;
    await addToCollection(collectionId, fingerprints);
    setShowAddToCollectionMenu(false);
    if (selectedCollectionId() === collectionId) {
      await refreshCollectionItems();
    }
    await refreshCollections();
  }

  async function handleRemoveFromCollection(fingerprints: string[]) {
    const colId = selectedCollectionId();
    if (!colId) return;
    if (fingerprints.length === 0) return;
    await removeFromCollection(colId, fingerprints);
    await refreshCollectionItems();
    await refreshCollections();
  }

  async function handleCreateAndAddToCollection(fingerprints: string[]) {
    const libId = params.selectedLibraryId();
    if (!libId) return;
    const col = await createCollection(libId, "Untitled");
    await refreshCollections();
    await handleAddToCollection(col.id, fingerprints);
  }

  createEffect(
    on(params.selectedLibraryId, () => {
      setSelectedCollectionId(null);
      void refreshCollections();
    }),
  );

  createEffect(
    on(selectedCollectionId, () => {
      void refreshCollectionItems();
    }),
  );

  return {
    collections,
    selectedCollectionId,
    setSelectedCollectionId,
    collectionItemPaths,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    showAddToCollectionMenu,
    setShowAddToCollectionMenu,
    refreshCollections,
    refreshCollectionItems,
    handleCreateCollection,
    handleRenameCollection,
    handleDeleteCollection,
    handleAddToCollection,
    handleRemoveFromCollection,
    handleCreateAndAddToCollection,
  };
}
