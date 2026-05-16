import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import {
  getCachedCameraLibraryItems,
  getCachedLocalLibraryItems,
  getCachedPeerLibraryItems,
  loadCameraLibraryItemsCachedOrRemote,
  loadLocalLibraryItemsCachedOrRemote,
  loadPeerLibraryItemsCachedOrRemote,
} from "../bridge/index";
import {
  applyStoredRatings,
  cameraLibraryHost,
  type LibraryData,
  localMediaItem,
  type MediaItem,
  peerMediaItem,
} from "../components/media-view/media-utils";

async function loadFreshItems(libraryId: string | null): Promise<MediaItem[]> {
  if (!libraryId) return [];
  if (libraryId.startsWith("peer:")) {
    const peerId = libraryId.slice("peer:".length);
    return applyStoredRatings(
      (await loadPeerLibraryItemsCachedOrRemote(peerId)).map((picture) =>
        peerMediaItem({ ...picture, peerId }),
      ),
    );
  }
  if (libraryId.startsWith("ccapi:")) {
    return applyStoredRatings(
      (await loadCameraLibraryItemsCachedOrRemote(cameraLibraryHost(libraryId))).map(
        localMediaItem,
      ),
    );
  }
  return applyStoredRatings(
    (await loadLocalLibraryItemsCachedOrRemote(libraryId)).items.map(localMediaItem),
  );
}

async function loadCachedItems(libraryId: string | null): Promise<MediaItem[]> {
  if (!libraryId) return [];
  if (libraryId.startsWith("peer:")) {
    const peerId = libraryId.slice("peer:".length);
    return applyStoredRatings(
      (await getCachedPeerLibraryItems(peerId)).map((picture) =>
        peerMediaItem({ ...picture, peerId }),
      ),
    );
  }
  if (libraryId.startsWith("ccapi:")) {
    return applyStoredRatings(
      (await getCachedCameraLibraryItems(cameraLibraryHost(libraryId))).map(
        localMediaItem,
      ),
    );
  }
  return applyStoredRatings(
    (await getCachedLocalLibraryItems(libraryId)).map(localMediaItem),
  );
}

export async function loadLibraryData(libraryId: string | null): Promise<LibraryData> {
  if (!libraryId) {
    return { libraryId, items: [], isComplete: true, error: null };
  }
  try {
    if (libraryId.startsWith("peer:") || libraryId.startsWith("ccapi:")) {
      return {
        libraryId,
        items: await loadFreshItems(libraryId),
        isComplete: true,
        error: null,
      };
    }
    const listing = await loadLocalLibraryItemsCachedOrRemote(libraryId);
    return {
      libraryId,
      items: await applyStoredRatings(listing.items.map(localMediaItem)),
      isComplete: listing.is_complete,
      error: null,
    };
  } catch (error) {
    return {
      libraryId,
      items: [],
      isComplete: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function useLibraryItems(libraryId: Accessor<string | null>): {
  items: Resource<LibraryData | undefined>;
  cached: Resource<MediaItem[] | undefined>;
  refetch: () => Promise<void>;
} {
  const [items, { refetch: refetchItems }] = createResource(libraryId, loadLibraryData);
  const [cached, { refetch: refetchCached }] = createResource(libraryId, loadCachedItems);

  const refreshIfCurrent = (msgLibraryId: string) => {
    if (msgLibraryId === libraryId()) {
      void refetchItems();
      void refetchCached();
    }
  };
  onCleanup(
    onChannelMessage("library_scan_complete", (msg) => refreshIfCurrent(msg.library_id)),
  );
  onCleanup(
    onChannelMessage("library_scan_progress", (msg) => refreshIfCurrent(msg.library_id)),
  );

  return {
    items,
    cached,
    refetch: async () => {
      await Promise.all([refetchItems(), refetchCached()]);
    },
  };
}
