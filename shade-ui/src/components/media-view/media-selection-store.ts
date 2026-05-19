import type { useMediaSelection } from "../../utils/use-media-selection";

export type MediaSelectionStore = ReturnType<typeof useMediaSelection>;

let mediaSelectionStore: MediaSelectionStore | null = null;

export function provideMediaSelectionStore(store: MediaSelectionStore) {
  mediaSelectionStore = store;
}

export function useMediaSelectionStore() {
  if (!mediaSelectionStore) {
    throw new Error("media selection store has not been provided");
  }
  return mediaSelectionStore;
}
