import { createSignal } from "solid-js";

export const [mediaViewFocusedItemId, setMediaViewFocusedItemId] = createSignal<string | null>(null);
export const [mediaViewSelectedItemIds, setMediaViewSelectedItemIds] = createSignal<string[]>([]);
export const [mediaViewSelectedLibraryId, setMediaViewSelectedLibraryId] = createSignal<string | null>(null);
