import {
  loadCameraLibraryItemsCachedOrRemote,
  loadLocalLibraryItemsCachedOrRemote,
  loadPeerLibraryItemsCachedOrRemote,
  listMediaRatings,
  resolveCameraThumbnailSrc,
  resolveLocalThumbnailSrc,
  resolvePeerThumbnailSrc,
  type LibraryImage,
  type MediaLibrary,
  type SharedPicture,
} from "../../bridge/index";
import { normalizeModifiedAt, normalizeRating, normalizeTags } from "../../cache-utils";
import { openImage, openPeerImage } from "../../store/editor";

export type LibraryEntry = MediaLibrary;
export type VisiblePeerLibrary = MediaLibrary & { kind: "peer" };

export type MediaItemMetadata = {
  hasSnapshots: boolean;
  latestSnapshotId: string | null;
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
      fileHash: string | null;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    }
  | {
      kind: "peer";
      id: string;
      name: string;
      peerId: string;
      fileHash: string | null;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    };

export type MediaGridRow =
  | { kind: "date"; modifiedAt: number | null }
  | { kind: "items"; ids: string[] };

export type LibraryData = {
  libraryId: string | null;
  items: MediaItem[];
  isComplete: boolean;
  error: string | null;
};

export type OpenMediaMode = "append" | "replace";

export type UploadProgress = {
  phase: "uploading" | "refreshing";
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
};

export type UploadDragFeedback = {
  itemCount: number | null;
};

type PeerLibraryItem = SharedPicture & { peerId: string };

function toPeerLibraryItem(peerId: string, picture: SharedPicture): PeerLibraryItem {
  return {
    ...picture,
    peerId,
  };
}

export function isPeerLibrary(library: LibraryEntry | null): library is VisiblePeerLibrary {
  return library?.kind === "peer";
}

export function peerLibraryPeerId(library: VisiblePeerLibrary) {
  return library.id.slice("peer:".length);
}

export function isLocalLibraryRefreshing(library: LibraryEntry | null) {
  return (
    !!library &&
    !isPeerLibrary(library) &&
    library.kind === "directory" &&
    library.is_refreshing
  );
}

export function isLibraryOffline(
  library: LibraryEntry | null,
  onlinePeerIds: Set<string>,
) {
  if (!library) {
    return false;
  }
  if (isPeerLibrary(library)) {
    return !onlinePeerIds.has(peerLibraryPeerId(library));
  }
  return library.is_online === false;
}

export function isCameraLibrary(
  library: LibraryEntry | null,
): library is MediaLibrary & { kind: "camera" } {
  return library?.kind === "camera";
}

export function isS3Library(
  library: LibraryEntry | null,
): library is MediaLibrary & { kind: "s3" } {
  return library?.kind === "s3";
}

export function isPinnedLibrary(library: LibraryEntry) {
  return library.id === "pictures";
}

export function libraryIsWritable(library: LibraryEntry | null) {
  return (
    !!library &&
    !isPeerLibrary(library) &&
    !library.readonly &&
    library.is_online !== false
  );
}

export function mergeLibraryOrder(order: string[], libraryIds: string[]) {
  const next = order.filter((id) => libraryIds.includes(id));
  for (const id of libraryIds) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  return next;
}

export function moveIdInOrder(order: string[], fromIdx: number, toIdx: number) {
  if (fromIdx === toIdx || fromIdx + 1 === toIdx) {
    return order;
  }
  if (fromIdx < 0 || fromIdx >= order.length) {
    throw new Error("source library index is out of bounds");
  }
  if (toIdx < 0 || toIdx > order.length) {
    throw new Error("target library index is out of bounds");
  }
  const next = [...order];
  const [moved] = next.splice(fromIdx, 1);
  const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
  next.splice(insertIdx, 0, moved);
  return next;
}

export function droppedFiles(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files ?? []);
}

export function draggedItemCount(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) {
    return null;
  }
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const fileItems = Array.from(dataTransfer.items).filter(
      (item) => item.kind === "file",
    );
    return fileItems.length > 0 ? fileItems.length : null;
  }
  return dataTransfer.files.length > 0 ? dataTransfer.files.length : null;
}

export function draggedPathCount(paths: string[] | null | undefined) {
  return paths && paths.length > 0 ? paths.length : null;
}

function clipboardImageExtension(type: string) {
  switch (type.toLowerCase()) {
    case "image/avif":
      return "avif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/tiff":
      return "tiff";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

export function clipboardImageFiles(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer?.items || dataTransfer.items.length === 0) {
    return [];
  }
  const createdAt = Date.now();
  let generatedCount = 0;
  const files: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (!file || !file.type.toLowerCase().startsWith("image/")) {
      continue;
    }
    if (file.name) {
      files.push(file);
      continue;
    }
    const extension = clipboardImageExtension(file.type);
    if (!extension) {
      throw new Error(`unsupported pasted image type: ${file.type}`);
    }
    generatedCount += 1;
    files.push(
      new File([file], `pasted-image-${createdAt}-${generatedCount}.${extension}`, {
        type: file.type,
      }),
    );
  }
  return files;
}

export function targetAcceptsTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

export function targetUsesOwnFocus(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.closest("button, input, textarea, select, a, [contenteditable='true']") !==
    null
  );
}

export function cameraLibraryHost(libraryId: string) {
  if (!libraryId.startsWith("ccapi:")) {
    throw new Error(`invalid camera library id: ${libraryId}`);
  }
  return libraryId.slice("ccapi:".length);
}

function pictureName(path: string) {
  return path.split("/").pop() ?? path;
}

export function normalizeFilenameFilter(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLocaleLowerCase())
    .filter((part) => part !== "");
}

export function filterMediaItemsByFilename(items: MediaItem[], filters: string[]) {
  if (filters.length === 0) {
    return items;
  }
  const nameLower = (item: MediaItem) => item.name.toLocaleLowerCase();
  return items.filter((item) =>
    filters.every(
      (filter) =>
        nameLower(item).includes(filter) ||
        item.metadata.tags.some((tag) => tag.toLocaleLowerCase().includes(filter)),
    ),
  );
}

function mediaRatingId(item: MediaItem) {
  return item.kind === "peer" ? `peer:${item.peerId}:${item.id}` : item.fileHash;
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

export async function applyStoredRatings(items: MediaItem[]) {
  const ratingIds = items
    .map((item) => ({ item, ratingId: mediaRatingId(item) }))
    .filter((entry): entry is { item: MediaItem; ratingId: string } => entry.ratingId !== null);
  const ratings = await listMediaRatings(ratingIds.map((entry) => entry.ratingId));
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

export function modificationMonthKey(modifiedAt: number | null | undefined) {
  const normalized = normalizeModifiedAt(modifiedAt);
  if (normalized === null) {
    return "unknown";
  }
  const date = new Date(normalized);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatModificationMonth(modifiedAt: number | null | undefined) {
  const normalized = normalizeModifiedAt(modifiedAt);
  if (normalized === null) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
  }).format(new Date(normalized));
}

export function localMediaItem(image: LibraryImage): MediaItem {
  return {
    kind: "local",
    id: image.path,
    name: image.name || pictureName(image.path),
    path: image.path,
    fileHash: image.file_hash,
    modifiedAt: normalizeModifiedAt(image.modified_at),
    metadata: {
      hasSnapshots: image.metadata?.has_snapshots ?? false,
      latestSnapshotId: image.metadata?.latest_snapshot_id ?? null,
      baseRating: normalizeRating(image.metadata?.rating),
      rating: normalizeRating(image.metadata?.rating),
      tags: normalizeTags(image.metadata?.tags),
    },
  };
}

export function peerMediaItem(image: PeerLibraryItem): MediaItem {
  return {
    kind: "peer",
    id: image.id,
    name: image.name,
    peerId: image.peerId,
    fileHash: null,
    modifiedAt: normalizeModifiedAt(image.modified_at),
    metadata: {
      hasSnapshots: image.has_snapshots,
      latestSnapshotId: image.latest_snapshot_id,
      baseRating: null,
      rating: null,
      tags: [],
    },
  };
}

export function mediaItemKey(item: MediaItem) {
  return item.kind === "peer" ? `peer:${item.peerId}:${item.id}` : `local:${item.id}`;
}

async function loadLibraryItems(libraryId: string | null): Promise<MediaItem[]> {
  if (!libraryId) {
    return [];
  }
  if (libraryId.startsWith("peer:")) {
    const peerId = libraryId.slice("peer:".length);
    return applyStoredRatings(
      (await loadPeerLibraryItemsCachedOrRemote(peerId)).map((picture) =>
        peerMediaItem(toPeerLibraryItem(peerId, picture)),
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

export async function loadLibraryData(libraryId: string | null): Promise<LibraryData> {
  if (!libraryId) {
    return {
      libraryId,
      items: [],
      isComplete: true,
      error: null,
    };
  }
  try {
    if (libraryId.startsWith("peer:") || libraryId.startsWith("ccapi:")) {
      return {
        libraryId,
        items: await loadLibraryItems(libraryId),
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

export async function loadItemSrc(
  item: MediaItem,
  signal: AbortSignal,
): Promise<string> {
  if (item.kind === "peer") {
    return resolvePeerThumbnailSrc(item.peerId, item.id, signal);
  }
  if (item.path.startsWith("ccapi://")) {
    return resolveCameraThumbnailSrc(item.path, item.metadata.latestSnapshotId, signal);
  }
  return resolveLocalThumbnailSrc(item.path, item.metadata.latestSnapshotId, signal);
}

export async function openMediaItem(
  item: MediaItem,
  libraryId: string,
  src: string | null,
  mode: OpenMediaMode = "replace",
) {
  const activeMediaSelection = {
    libraryId,
    itemId: mediaItemKey(item),
    fileHash: item.fileHash,
    rating: item.metadata.rating,
    baseRating: item.metadata.baseRating,
  };
  if (item.kind === "peer") {
    const picture: SharedPicture = {
      id: item.id,
      name: item.name,
      modified_at: item.modifiedAt,
      has_snapshots: item.metadata.hasSnapshots,
      latest_snapshot_id: item.metadata.latestSnapshotId,
    };
    await openPeerImage(item.peerId, picture, src, activeMediaSelection, mode);
    return;
  }
  await openImage(item.path, src, activeMediaSelection, mode);
}
