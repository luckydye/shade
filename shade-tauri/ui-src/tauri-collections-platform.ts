import type {
  Collection,
  CollectionItem,
  CollectionsPlatform,
} from "shade-ui/src/bridge/index";
import { getTauriPlatform } from "shade-ui/src/bridge/index";
import {
  onChannelMessage,
  sendMutation,
  sendRead,
} from "shade-ui/src/bridge/channel";

function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return getTauriPlatform().invoke<T>(cmd, args);
}

export const tauriCollectionsPlatform: CollectionsPlatform = {
  listCollections(libraryId) {
    return sendRead<Collection[]>(
      { type: "list_collections", library_id: libraryId },
      "collections",
    );
  },
  // `create_collection` rides `dispatch_mutation`; the freshly-minted record
  // arrives over the channel as `collection_created`. Correlation here is
  // by `library_id + name` — fine because the UI never fires concurrent
  // creates with the same name in the same library.
  createCollection(libraryId, name) {
    return new Promise<Collection>((resolve, reject) => {
      let settled = false;
      const unsub = onChannelMessage("collection_created", (msg) => {
        if (settled) return;
        const collection = msg.collection as Collection | undefined;
        if (
          !collection ||
          collection.library_id !== libraryId ||
          collection.name !== name
        ) {
          return;
        }
        settled = true;
        unsub();
        resolve(collection);
      });
      sendMutation({
        type: "create_collection",
        library_id: libraryId,
        name,
      }).catch((err) => {
        if (settled) return;
        settled = true;
        unsub();
        reject(err);
      });
    });
  },
  async renameCollection(collectionId, name) {
    await sendMutation({
      type: "rename_collection",
      collection_id: collectionId,
      name,
    });
  },
  async deleteCollection(collectionId) {
    await sendMutation({
      type: "delete_collection",
      collection_id: collectionId,
    });
  },
  async reorderCollection(collectionId, newPosition) {
    await sendMutation({
      type: "reorder_collection",
      collection_id: collectionId,
      new_position: newPosition,
    });
  },
  listCollectionItems(collectionId) {
    return sendRead<CollectionItem[]>(
      { type: "list_collection_items", collection_id: collectionId },
      "collection_items",
    );
  },
  async addToCollection(collectionId, fingerprints) {
    await sendMutation({
      type: "add_to_collection",
      collection_id: collectionId,
      fingerprints,
    });
  },
  async removeFromCollection(collectionId, fingerprints) {
    await sendMutation({
      type: "remove_from_collection",
      collection_id: collectionId,
      fingerprints,
    });
  },
};
