import { createSignal } from "solid-js";

export const [mediaViewFocusedItemId, setMediaViewFocusedItemId] = createSignal<
  string | null
>(null);
export const [mediaViewSelectedItemIds, setMediaViewSelectedItemIds] = createSignal<
  string[]
>([]);
export const [mediaViewSelectedLibraryId, setMediaViewSelectedLibraryId] = createSignal<
  string | null
>(null);

export type BatchItem = {
  path: string;
  fingerprint: string | null;
  kind: "local" | "peer";
  peerId?: string;
  id?: string;
};
export const [mediaViewSelectedBatchItems, setMediaViewSelectedBatchItems] = createSignal<
  BatchItem[]
>([]);
export const [mediaViewFocusedItem, setMediaViewFocusedItem] =
  createSignal<BatchItem | null>(null);
