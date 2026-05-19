import { type Accessor, createResource, onCleanup, type Resource } from "solid-js";
import { onChannelMessage } from "../bridge/channel";
import * as bridge from "../bridge/index";
import {
  getCachedCameraLibraryItems,
  getCachedLocalLibraryItems,
  getCachedPeerLibraryItems,
  loadCameraLibraryItemsCachedOrRemote,
  loadLocalLibraryItemsCachedOrRemote,
  loadPeerLibraryItemsCachedOrRemote,
} from "../bridge/index";
import type { LibraryImage, SharedPicture } from "../types";
import { normalizeModifiedAt, normalizeRating, normalizeTags } from "../utils";

export type MediaItemMetadata = {
  hasSnapshots: boolean;
  latestSnapshotId: string | null;
  latestSnapshotCreatedAt: number | null;
  baseRating: number | null;
  rating: number | null;
  tags: string[];
};

export type MediaItem =
  | {
      kind: "local";
      id: string;
      name: string;
      path: string;
      fingerprint: string | null;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    }
  | {
      kind: "peer";
      id: string;
      name: string;
      peerId: string;
      fingerprint: string | null;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    };

export type LibraryData = {
  libraryId: string | null;
  items: MediaItem[];
  isComplete: boolean;
  error: string | null;
};

type PeerLibraryItem = SharedPicture & { peerId: string };

function cameraLibraryHost(libraryId: string) {
  if (!libraryId.startsWith("ccapi:")) {
    throw new Error(`invalid camera library id: ${libraryId}`);
  }
  return libraryId.slice("ccapi:".length);
}

function pictureName(path: string) {
  return path.split("/").pop() ?? path;
}

function localMediaItem(image: LibraryImage): MediaItem {
  return {
    kind: "local",
    id: image.path,
    name: image.name || pictureName(image.path),
    path: image.path,
    fingerprint: image.fingerprint,
    modifiedAt: normalizeModifiedAt(image.modified_at),
    metadata: {
      hasSnapshots: image.metadata?.has_snapshots ?? false,
      latestSnapshotId: image.metadata?.latest_snapshot_id ?? null,
      latestSnapshotCreatedAt: image.metadata?.latest_snapshot_created_at ?? null,
      baseRating: normalizeRating(image.metadata?.rating),
      rating: normalizeRating(image.metadata?.rating),
      tags: normalizeTags(image.metadata?.tags),
    },
  };
}

function peerMediaItem(image: PeerLibraryItem): MediaItem {
  return {
    kind: "peer",
    id: image.id,
    name: image.name,
    peerId: image.peerId,
    fingerprint: null,
    modifiedAt: normalizeModifiedAt(image.modified_at),
    metadata: {
      hasSnapshots: image.has_snapshots,
      latestSnapshotId: image.latest_snapshot_id,
      latestSnapshotCreatedAt: null,
      baseRating: null,
      rating: null,
      tags: [],
    },
  };
}

function mediaRatingId(item: MediaItem) {
  if (item.kind === "peer") {
    return `peer:${item.peerId}:${item.id}`;
  }
  return item.fingerprint ?? item.path;
}

function withMediaItemRating(item: MediaItem, rating: number | null): MediaItem {
  return {
    ...item,
    metadata: {
      ...item.metadata,
      rating,
    },
  };
}

async function applyStoredRatings(items: MediaItem[]) {
  const ratingIds = items
    .map((item) => ({ item, ratingId: mediaRatingId(item) }))
    .filter(
      (entry): entry is { item: MediaItem; ratingId: string } => entry.ratingId !== null,
    );
  const ratings = await bridge.listMediaRatings(ratingIds.map((entry) => entry.ratingId));
  return items.map((item) => {
    const ratingId = mediaRatingId(item);
    if (!ratingId) {
      return item;
    }
    const storedRating = ratings[ratingId];
    if (storedRating === undefined) {
      return item;
    }
    return withMediaItemRating(item, normalizeRating(storedRating));
  });
}

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
  uploadMediaLibraryFile: (
    libraryId: string,
    file: File,
    appendTimestampOnConflict?: boolean,
  ) => Promise<void>;
  uploadMediaLibraryUrl: (
    libraryId: string,
    url: string,
    fileName: string,
  ) => Promise<void>;
  uploadMediaLibraryPath: (libraryId: string, path: string) => Promise<void>;
  deleteMediaLibraryItem: (path: string) => Promise<void>;
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
    uploadMediaLibraryFile,
    uploadMediaLibraryUrl,
    uploadMediaLibraryPath,
    deleteMediaLibraryItem,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Rust emits `library_scan_*` after writes for ongoing scans; uploads are
// reflected via the next library scan tick.

function uploadMediaLibraryFile(
  libraryId: string,
  file: File,
  appendTimestampOnConflict = false,
): Promise<void> {
  return bridge.uploadMediaLibraryFile(libraryId, file, appendTimestampOnConflict);
}

function uploadMediaLibraryUrl(
  libraryId: string,
  url: string,
  fileName: string,
): Promise<void> {
  return bridge.uploadMediaLibraryUrl(libraryId, url, fileName);
}

function uploadMediaLibraryPath(libraryId: string, path: string): Promise<void> {
  return bridge.uploadMediaLibraryPath(libraryId, path);
}

function deleteMediaLibraryItem(path: string): Promise<void> {
  return bridge.deleteMediaLibraryItem(path);
}
