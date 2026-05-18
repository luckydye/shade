import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import type { CollectionItem } from "../bridge/types";

export function useCollectionItems(collectionId: Accessor<string | null>): {
  items: Resource<CollectionItem[] | undefined>;
  refetch: () => Promise<void>;
  addToCollection: (collectionId: string, fingerprints: string[]) => Promise<void>;
  removeFromCollection: (collectionId: string, fingerprints: string[]) => Promise<void>;
} {
  const [items, { refetch }] = createResource(collectionId, (id) =>
    id ? bridge.listCollectionItems(id) : Promise.resolve<CollectionItem[]>([]),
  );

  onCleanup(
    onChannelMessage("collection_changed", (msg) => {
      if (msg.collection_id === collectionId()) {
        void refetch();
      }
    }),
  );

  return {
    items,
    refetch: async () => {
      await refetch();
    },
    addToCollection,
    removeFromCollection,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Rust emits `collection_changed` after writes.

function addToCollection(collectionId: string, fingerprints: string[]): Promise<void> {
  return bridge.addToCollection(collectionId, fingerprints);
}

function removeFromCollection(
  collectionId: string,
  fingerprints: string[],
): Promise<void> {
  return bridge.removeFromCollection(collectionId, fingerprints);
}
