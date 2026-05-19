import type { MediaLibrary, SharedPicture } from "../../types";
import type { MediaItem } from "../../data/use-library-items";
import {
  resolveCameraThumbnailSrc,
  resolveLocalThumbnailSrc,
  resolvePeerThumbnailSrc,
} from "../../data/use-thumbnail-src";
import { useOpenImage } from "../../store/use-open-image";
import { normalizeModifiedAt } from "../../utils";

export type LibraryEntry = MediaLibrary;
export type VisiblePeerLibrary = MediaLibrary & { kind: "peer" };

export type MediaGridRow =
  | { kind: "date"; modifiedAt: number | null }
  | { kind: "items"; ids: string[] };

export type OpenMediaMode = "append" | "replace";

export type UploadDragFeedback = {
  itemCount: number | null;
};

export function isPeerLibrary(
  library: LibraryEntry | null,
): library is VisiblePeerLibrary {
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
  const now = new Date();
  const createdAt = now
    .toISOString()
    .replace(/T/, "-")
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
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

export function mediaItemKey(item: MediaItem) {
  return item.kind === "peer" ? `peer:${item.peerId}:${item.id}` : `local:${item.id}`;
}

export async function loadItemSrc(item: MediaItem, signal: AbortSignal): Promise<string> {
  if (item.kind === "peer") {
    return resolvePeerThumbnailSrc(item.peerId, item.id, signal);
  }
  if (item.path.startsWith("ccapi://")) {
    return resolveCameraThumbnailSrc(item.path, item.metadata.latestSnapshotId, signal);
  }
  const path =
    item.path.startsWith("s3://") && item.modifiedAt != null
      ? `${item.path}#${item.modifiedAt}`
      : item.path;
  return resolveLocalThumbnailSrc(path, item.metadata.latestSnapshotId, signal);
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
    fingerprint: item.fingerprint,
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
    await useOpenImage().openPeer(item.peerId, picture, src, activeMediaSelection, mode);
    return;
  }
  await useOpenImage().open(item.path, src, activeMediaSelection, mode);
}
