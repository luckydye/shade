import { createEffect, createMemo, createSignal } from "solid-js";
import {
  isLibraryOffline,
  isLocalLibraryRefreshing,
  isPeerLibrary,
  isS3Library,
  type LibraryEntry,
  libraryIsWritable,
} from "../components/media-view/media-utils";
import { state } from "../store/editor-store";
import { useMediaLibraryList } from "./use-media-library-list";
import { usePeerDiscovery } from "./use-peer-discovery";

export function useMediaLibraryState() {
  const {
    libraries,
    refetch: refetchLibraries,
    refreshLibraryIndex,
    syncLibrary,
  } = useMediaLibraryList();
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const { peers: discoveredPeers } = usePeerDiscovery();
  const onlinePeerIds = createMemo(
    () => new Set(discoveredPeers().map((peer) => peer.endpoint_id)),
  );

  const libraryEntries = createMemo<LibraryEntry[]>(() => libraries() ?? []);
  const selectedLibrary = createMemo(
    () => libraryEntries().find((library) => library.id === selectedLibraryId()) ?? null,
  );
  const selectedLibraryIsRefreshing = createMemo(() =>
    isLocalLibraryRefreshing(selectedLibrary()) === true,
  );
  const selectedLibraryIsOffline = createMemo(() =>
    isLibraryOffline(selectedLibrary(), onlinePeerIds()),
  );
  const hasLibraries = createMemo(() => libraryEntries().length > 0);
  const canWriteSelectedLibrary = createMemo(() => libraryIsWritable(selectedLibrary()));
  const shouldDeferEditorStripThumbnails = createMemo(
    () => state.currentView === "editor" && isS3Library(selectedLibrary()),
  );

  createEffect(() => {
    const availableLibraries = libraryEntries();
    if (!availableLibraries.length) {
      setSelectedLibraryId(null);
      return;
    }
    const current = selectedLibraryId();
    if (current && availableLibraries.some((library) => library.id === current)) {
      return;
    }
    const firstLocalLibrary = availableLibraries.find(
      (library) => !isPeerLibrary(library),
    );
    setSelectedLibraryId(firstLocalLibrary?.id ?? null);
  });

  return {
    selectedLibraryId,
    setSelectedLibraryId,
    selectedLibrary,
    libraryEntries,
    refetchLibraries,
    refreshLibraryIndex,
    syncLibrary,
    hasLibraries,
    selectedLibraryIsRefreshing,
    selectedLibraryIsOffline,
    canWriteSelectedLibrary,
    shouldDeferEditorStripThumbnails,
  };
}
