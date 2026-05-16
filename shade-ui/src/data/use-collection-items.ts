import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import {
  type CollectionItem,
  listCollectionItems as fetchCollectionItems,
} from "../bridge/index";

export function useCollectionItems(collectionId: Accessor<string | null>): {
  items: Resource<CollectionItem[] | undefined>;
  refetch: () => Promise<void>;
} {
  const [items, { refetch }] = createResource(collectionId, (id) =>
    id ? fetchCollectionItems(id) : Promise.resolve<CollectionItem[]>([]),
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
  };
}
