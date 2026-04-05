import type {
  Collection,
  CollectionItem,
  CollectionsPlatform,
} from "shade-ui/src/bridge/index";
import { getTauriPlatform } from "shade-ui/src/bridge/index";

function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return getTauriPlatform().invoke<T>(cmd, args);
}

export const tauriCollectionsPlatform: CollectionsPlatform = {
  listCollections(libraryId) {
    return inv<Collection[]>("list_collections", { libraryId });
  },
  createCollection(libraryId, name) {
    return inv<Collection>("create_collection", { libraryId, name });
  },
  async renameCollection(collectionId, name) {
    await inv("rename_collection", { collectionId, name });
  },
  async deleteCollection(collectionId) {
    await inv("delete_collection", { collectionId });
  },
  async reorderCollection(collectionId, newPosition) {
    await inv("reorder_collection", { collectionId, newPosition });
  },
  listCollectionItems(collectionId) {
    return inv<CollectionItem[]>("list_collection_items", { collectionId });
  },
  async addToCollection(collectionId, fileHashes) {
    await inv("add_to_collection", { collectionId, fileHashes });
  },
  async removeFromCollection(collectionId, fileHashes) {
    await inv("remove_from_collection", { collectionId, fileHashes });
  },
};
