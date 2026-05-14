import type {
  Collection,
  CollectionItem,
  CollectionsPlatform,
} from "shade-ui/src/bridge/index";
import { getTauriPlatform } from "shade-ui/src/bridge/index";
import { sendMutation } from "shade-ui/src/bridge/channel";

function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return getTauriPlatform().invoke<T>(cmd, args);
}

function rawInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return getTauriPlatform().invoke(cmd, args);
}

export const tauriCollectionsPlatform: CollectionsPlatform = {
  listCollections(libraryId) {
    return inv<Collection[]>("list_collections", { libraryId });
  },
  // `create_collection` stays as a regular invoke — the caller needs the
  // freshly-minted Collection (id/position/created_at) right away.
  createCollection(libraryId, name) {
    return inv<Collection>("create_collection", { libraryId, name });
  },
  async renameCollection(collectionId, name) {
    await sendMutation(rawInvoke, {
      type: "rename_collection",
      collection_id: collectionId,
      name,
    });
  },
  async deleteCollection(collectionId) {
    await sendMutation(rawInvoke, {
      type: "delete_collection",
      collection_id: collectionId,
    });
  },
  async reorderCollection(collectionId, newPosition) {
    await sendMutation(rawInvoke, {
      type: "reorder_collection",
      collection_id: collectionId,
      new_position: newPosition,
    });
  },
  listCollectionItems(collectionId) {
    return inv<CollectionItem[]>("list_collection_items", { collectionId });
  },
  async addToCollection(collectionId, fingerprints) {
    await sendMutation(rawInvoke, {
      type: "add_to_collection",
      collection_id: collectionId,
      fingerprints,
    });
  },
  async removeFromCollection(collectionId, fingerprints) {
    await sendMutation(rawInvoke, {
      type: "remove_from_collection",
      collection_id: collectionId,
      fingerprints,
    });
  },
};
