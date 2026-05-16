import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import { type Collection } from "../bridge/index";

export function useCollectionList(libraryId: Accessor<string | null>): {
  collections: Resource<Collection[] | undefined>;
  refetch: () => Promise<void>;
} {
  const [collections, { refetch }] = createResource(libraryId, (id) =>
    id ? bridge.listCollections(id) : Promise.resolve<Collection[]>([]),
  );

  onCleanup(
    onChannelMessage("collection_list_changed", () => {
      void refetch();
    }),
  );
  onCleanup(
    onChannelMessage("collection_created", () => {
      void refetch();
    }),
  );

  return {
    collections,
    refetch: async () => {
      await refetch();
    },
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Rust emits `collection_list_changed` / `collection_created` after writes.

export function createCollection(libraryId: string, name: string): Promise<Collection> {
  return bridge.createCollection(libraryId, name);
}

export function renameCollection(collectionId: string, name: string): Promise<void> {
  return bridge.renameCollection(collectionId, name);
}

export function deleteCollection(collectionId: string): Promise<void> {
  return bridge.deleteCollection(collectionId);
}

export function reorderCollection(
  collectionId: string,
  newPosition: number,
): Promise<void> {
  return bridge.reorderCollection(collectionId, newPosition);
}
