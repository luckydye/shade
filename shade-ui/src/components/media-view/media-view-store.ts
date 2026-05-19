import type { Accessor, Setter } from "solid-js";
import { createRoot, createSignal } from "solid-js";
import type { MediaItem } from "../../data/use-library-items";
import type { PresetInfo } from "../../types";
import type { LibraryEntry } from "./media-utils";

type MediaViewSelectionState = {
  selectedMediaItemIds: Accessor<string[]>;
  setSelectedMediaItemIds: Setter<string[]>;
  keyboardNavActive: Accessor<boolean>;
  setKeyboardNavActive: Setter<boolean>;
  focusedItemId: Accessor<string | null>;
  setFocusedItemId: Setter<string | null>;
};

export type MediaViewStoreInput = {
  selectedLibraryId: Accessor<string | null>;
  setSelectedLibraryId: Setter<string | null>;
  selectedLibrary: Accessor<LibraryEntry | null>;
  libraryEntries: Accessor<LibraryEntry[]>;
  refetchLibraries: () => unknown;
  availableItemCount: Accessor<number>;
  filenameFilter: Accessor<string>;
  setFilenameFilter: Setter<string>;
  flatItemIds: Accessor<string[]>;
  itemsById: Accessor<Map<string, MediaItem>>;
  canWriteSelectedLibrary: Accessor<boolean>;
  isSubmitting: Accessor<boolean>;
  setIsSubmitting: Setter<boolean>;
  presets: Accessor<PresetInfo[] | null | undefined>;
  refetchPresets: () => unknown;
  showApplyPresetMenu: Accessor<boolean>;
  setError: Setter<string | null>;
  setMediaActionStatus: Setter<string | null>;
  setShowApplyPresetMenu: Setter<boolean>;
  zoomIndex: Accessor<number>;
  setZoomIndex: Setter<number>;
  zoomLevelCount: number;
  syncProgress: Accessor<unknown>;
  pickDirectory: () => Promise<string | null>;
  addMediaLibrary: (path: string) => Promise<LibraryEntry>;
  deleteMediaLibraryItem: (path: string) => Promise<unknown>;
  uploadMediaLibraryFile: (
    libraryId: string,
    file: File,
    appendTimestampOnConflict?: boolean,
  ) => Promise<unknown>;
  uploadMediaLibraryPath: (libraryId: string, path: string) => Promise<unknown>;
  uploadMediaLibraryUrl: (
    libraryId: string,
    url: string,
    fileName: string,
  ) => Promise<unknown>;
  refreshLibraryIndex: (libraryId: string) => Promise<unknown>;
  refetchItems: () => unknown;
  refetchCachedLibraryItems: () => unknown;
  layerOps: {
    applyPresetSnapshot: (name: string, path: string | null) => Promise<unknown>;
  };
  batchOps: {
    applyPresetSnapshot: (
      items: { path: string; fingerprint: string | null }[],
      name: string,
    ) => Promise<number>;
    clearEdits: (paths: string[]) => Promise<number>;
    exportImages: (
      items: { path: string; fingerprint: string | null; name: string }[],
      targetDir: string,
    ) => Promise<number>;
  };
};

export type MediaViewStore = MediaViewStoreInput & MediaViewSelectionState;

const selectionState = createRoot<MediaViewSelectionState>(() => {
  const [selectedMediaItemIds, setSelectedMediaItemIds] = createSignal<string[]>([]);
  const [keyboardNavActive, setKeyboardNavActive] = createSignal(false);
  const [focusedItemId, setFocusedItemId] = createSignal<string | null>(null);
  return {
    selectedMediaItemIds,
    setSelectedMediaItemIds,
    keyboardNavActive,
    setKeyboardNavActive,
    focusedItemId,
    setFocusedItemId,
  };
});

let mediaViewStore: MediaViewStoreInput | null = null;

export function provideMediaViewStore(store: MediaViewStoreInput) {
  mediaViewStore = store;
}

export function useMediaViewStore() {
  if (!mediaViewStore) {
    throw new Error("media view store has not been provided");
  }
  return {
    ...mediaViewStore,
    ...selectionState,
  };
}
