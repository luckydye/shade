import type { useCollectionMembership } from "../../utils/use-collection-membership";

export type CollectionMembershipStore = ReturnType<typeof useCollectionMembership>;

let collectionMembershipStore: CollectionMembershipStore | null = null;

export function provideCollectionMembershipStore(store: CollectionMembershipStore) {
  collectionMembershipStore = store;
}

export function useCollectionMembershipStore() {
  if (!collectionMembershipStore) {
    throw new Error("collection membership store has not been provided");
  }
  return collectionMembershipStore;
}
