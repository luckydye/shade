import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import { type Collection, listCollections as fetchCollections } from "../bridge/index";

export function useCollectionList(libraryId: Accessor<string | null>): {
  collections: Resource<Collection[] | undefined>;
  refetch: () => Promise<void>;
} {
  const [collections, { refetch }] = createResource(libraryId, (id) =>
    id ? fetchCollections(id) : Promise.resolve<Collection[]>([]),
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
