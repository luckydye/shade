import type { Component, JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  addMediaLibrary,
  addS3MediaLibrary,
  deleteMediaLibraryItem,
  isTauriRuntime,
  type LibraryImage,
  listMediaLibraries,
  listMediaRatings,
  type MediaLibrary,
  pairPeerDevice,
  pickDirectory,
  refreshLibraryIndex,
  removeMediaLibrary,
  type S3MediaLibraryInput,
  type SharedPicture,
  setMediaLibraryOrder,
  uploadMediaLibraryFile,
  uploadMediaLibraryPath,
} from "../bridge/index";
import {
  getCachedCameraLibraryItems,
  loadCameraLibraryItemsCachedOrRemote,
  resetCameraThumbnailFailure,
  resolveCameraThumbnailSrc,
} from "../camera-library-cache";
import {
  getCachedLocalLibraryItems,
  loadLocalLibraryItemsCachedOrRemote,
  resetLocalThumbnailFailure,
  resolveLocalThumbnailSrc,
} from "../local-library-cache";
import {
  getCachedPeerLibraryItems,
  loadPeerLibraryItemsCachedOrRemote,
  type PeerLibraryItem,
  removePeerLibrary,
  resolvePeerThumbnailSrc,
} from "../peer-library-cache";
import {
  isAdjustmentSliderActive,
  openImage,
  openPeerImage,
  showMediaView,
  state,
} from "../store/editor";
import { p2pState, startP2pPolling, stopP2pPolling } from "../store/p2p";
import { Button } from "./Button";
import { MediaRating } from "./MediaRating";
import { ActionButton } from "./ActionButton";

type LibraryEntry = MediaLibrary;
type VisiblePeerLibrary = MediaLibrary & { kind: "peer" };

type MediaItemMetadata = {
  hasSnapshots: boolean;
  latestSnapshotId: string | null;
  baseRating: number | null;
  rating: number | null;
  tags: string[];
};

type MediaItem =
  | {
      kind: "local";
      id: string;
      name: string;
      path: string;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    }
  | {
      kind: "peer";
      id: string;
      name: string;
      peerId: string;
      modifiedAt: number | null;
      metadata: MediaItemMetadata;
    };

type MediaGridRow =
  | { kind: "date"; modifiedAt: number | null }
  | { kind: "items"; ids: string[] };

type LibraryData = {
  libraryId: string | null;
  items: MediaItem[];
  isComplete: boolean;
  error: string | null;
};

type OpenMediaMode = "append" | "replace";

type UploadProgress = {
  phase: "uploading" | "refreshing";
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
};

type UploadDragFeedback = {
  itemCount: number | null;
};

const GRID_GAP = 12;
const TILE_LABEL_HEIGHT = 24;
const HEADER_ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 2;
const PANEL_SECTION_TITLE_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]";
const SURFACE_BUTTON_CLASS =
  "h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40";
const DANGER_BUTTON_CLASS =
  "h-8 rounded-md border border-[var(--danger-border)] bg-transparent px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] transition-colors hover:border-[var(--danger-hover-border)] hover:text-[var(--danger-hover-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger-hover-border)] disabled:opacity-40";
const MENU_ITEM_BUTTON_CLASS =
  "flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40";
const MENU_DANGER_ITEM_BUTTON_CLASS =
  "flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--danger-hover-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger-hover-border)] disabled:opacity-40";
const INPUT_CLASS =
  "h-10 md:h-8 w-full rounded-full md:rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-4 md:px-2 text-base md:text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const EMPTY_STATE_CLASS =
  "px-3 py-4 text-sm text-[var(--text-faint)]";
const EMPTY_STATE_PANEL_CLASS =
  "mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-medium)] bg-[var(--surface-subtle)] px-6 py-8 text-center";
const LIBRARY_TAB_BASE_CLASS =
  "inline-flex h-7 shrink-0 items-center rounded-full border px-4 text-[12px] font-semibold tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";

function isPeerLibrary(library: LibraryEntry | null): library is VisiblePeerLibrary {
  return library?.kind === "peer";
}

function peerLibraryPeerId(library: VisiblePeerLibrary) {
  return library.id.slice("peer:".length);
}

function isLocalLibraryRefreshing(library: LibraryEntry | null) {
  return (
    !!library &&
    !isPeerLibrary(library) &&
    library.kind === "directory" &&
    library.is_refreshing
  );
}

function isLibraryOffline(library: LibraryEntry | null, onlinePeerIds: Set<string>) {
  if (!library) {
    return false;
  }
  if (isPeerLibrary(library)) {
    return !onlinePeerIds.has(peerLibraryPeerId(library));
  }
  return library.is_online === false;
}

function isCameraLibrary(
  library: LibraryEntry | null,
): library is MediaLibrary & { kind: "camera" } {
  return library?.kind === "camera";
}

function isS3Library(
  library: LibraryEntry | null,
): library is MediaLibrary & { kind: "s3" } {
  return library?.kind === "s3";
}

function isPinnedLibrary(library: LibraryEntry) {
  return library.id === "pictures";
}

function libraryIsWritable(library: LibraryEntry | null) {
  return (
    !!library &&
    !isPeerLibrary(library) &&
    !library.readonly &&
    library.is_online !== false
  );
}

function mergeLibraryOrder(order: string[], libraryIds: string[]) {
  const next = order.filter((id) => libraryIds.includes(id));
  for (const id of libraryIds) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  return next;
}

function moveIdInOrder(order: string[], fromIdx: number, toIdx: number) {
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

function droppedFiles(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) {
    return [];
  }
  return Array.from(dataTransfer.files ?? []);
}

function draggedItemCount(dataTransfer: DataTransfer | null | undefined) {
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

function draggedPathCount(paths: string[] | null | undefined) {
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

function clipboardImageFiles(dataTransfer: DataTransfer | null | undefined) {
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

function targetAcceptsTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

function targetUsesOwnFocus(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.closest("button, input, textarea, select, a, [contenteditable='true']") !==
    null
  );
}

function cameraLibraryHost(libraryId: string) {
  if (!libraryId.startsWith("ccapi:")) {
    throw new Error(`invalid camera library id: ${libraryId}`);
  }
  return libraryId.slice("ccapi:".length);
}

function pictureName(path: string) {
  return path.split("/").pop() ?? path;
}

function normalizeFilenameFilter(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLocaleLowerCase())
    .filter((part) => part !== "");
}

function filterMediaItemsByFilename(items: MediaItem[], filters: string[]) {
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

function normalizeModifiedAt(modifiedAt: number | null | undefined) {
  return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
    ? modifiedAt
    : null;
}

function normalizeRating(rating: number | null | undefined) {
  return typeof rating === "number" &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
    ? rating
    : null;
}

function normalizeTags(tags: string[] | null | undefined) {
  return Array.isArray(tags)
    ? tags.filter((tag) => typeof tag === "string" && tag.trim() !== "")
    : [];
}

function mediaRatingId(item: MediaItem) {
  return item.kind === "peer" ? `peer:${item.peerId}:${item.id}` : item.path;
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
  const ratings = await listMediaRatings(items.map(mediaRatingId));
  return items.map((item) => {
    const storedRating = ratings[mediaRatingId(item)];
    if (storedRating === undefined) {
      return item;
    }
    return withMediaItemRating(item, normalizeRating(storedRating));
  });
}

function modificationMonthKey(modifiedAt: number | null | undefined) {
  const normalized = normalizeModifiedAt(modifiedAt);
  if (normalized === null) {
    return "unknown";
  }
  const date = new Date(normalized);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatModificationMonth(modifiedAt: number | null | undefined) {
  const normalized = normalizeModifiedAt(modifiedAt);
  if (normalized === null) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
  }).format(new Date(normalized));
}

function localMediaItem(image: LibraryImage): MediaItem {
  return {
    kind: "local",
    id: image.path,
    name: image.name || pictureName(image.path),
    path: image.path,
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

function peerMediaItem(image: PeerLibraryItem): MediaItem {
  return {
    kind: "peer",
    id: image.id,
    name: image.name,
    peerId: image.peerId,
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

function mediaItemKey(item: MediaItem) {
  return item.kind === "peer" ? `peer:${item.peerId}:${item.id}` : `local:${item.id}`;
}

async function loadLibraryItems(libraryId: string | null): Promise<MediaItem[]> {
  if (!libraryId) {
    return [];
  }
  if (libraryId.startsWith("peer:")) {
    const peerId = libraryId.slice("peer:".length);
    return applyStoredRatings(
      (await loadPeerLibraryItemsCachedOrRemote(peerId)).map(peerMediaItem),
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

async function loadLibraryData(libraryId: string | null): Promise<LibraryData> {
  if (!libraryId) {
    return {
      libraryId,
      items: [],
      isComplete: true,
      error: null,
    };
  }
  try {
    if (libraryId.startsWith("peer:")) {
      return {
        libraryId,
        items: await loadLibraryItems(libraryId),
        isComplete: true,
        error: null,
      };
    }
    if (libraryId.startsWith("ccapi:")) {
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

async function loadItemSrc(item: MediaItem, signal: AbortSignal): Promise<string> {
  if (item.kind === "peer") {
    return resolvePeerThumbnailSrc(item.peerId, item.id, signal);
  }
  if (item.path.startsWith("ccapi://")) {
    return resolveCameraThumbnailSrc(item.path, item.metadata.latestSnapshotId, signal);
  }
  return resolveLocalThumbnailSrc(item.path, item.metadata.latestSnapshotId, signal);
}

async function openMediaItem(
  item: MediaItem,
  libraryId: string,
  src: string | null,
  mode: OpenMediaMode = "replace",
) {
  const activeMediaSelection = {
    libraryId,
    itemId: mediaItemKey(item),
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

const MediaTile: Component<{
  item: MediaItem;
  compact?: boolean;
  active?: boolean;
  selected?: boolean;
  showSelectionControls?: boolean;
  offline?: boolean;
  disableThumbnailLoad?: boolean;
  onActivate: (src: string | null) => void;
  onToggleSelection: () => void;
}> = (props) => {
  const [isIntersecting, setIsIntersecting] = createSignal(false);
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  const [loadError, setLoadError] = createSignal(false);
  const [loadRequestVersion, setLoadRequestVersion] = createSignal(0);
  let containerRef: HTMLDivElement | undefined;
  let imgRef: HTMLImageElement | undefined;
  let isLoadingSrc = false;

  onMount(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    if (containerRef) observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    loadRequestVersion();
    if (props.disableThumbnailLoad || !isIntersecting() || src() || isLoadingSrc) {
      return;
    }
    const controller = new AbortController();
    setLoadError(false);
    isLoadingSrc = true;
    void loadItemSrc(props.item, controller.signal)
      .then((nextSrc) => setSrc(nextSrc))
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        if (props.offline) {
          return;
        }
        setLoadError(true);
      })
      .finally(() => {
        isLoadingSrc = false;
      });
    onCleanup(() => {
      controller.abort();
      isLoadingSrc = false;
    });
  });

  onCleanup(() => {
    const url = src();
    if (url?.startsWith("blob:") && url !== state.loadingMediaSrc) {
      URL.revokeObjectURL(url);
    }
  });

  function handleClick(event: JSX.MouseEventHandler<HTMLButtonElement, MouseEvent>) {
    if (event.metaKey || event.ctrlKey) {
      props.onToggleSelection();
      return;
    }
    if (!src()) {
      if (props.item.kind === "local") {
        if (props.item.path.startsWith("ccapi://")) {
          resetCameraThumbnailFailure(props.item.path);
        } else {
          resetLocalThumbnailFailure(props.item.path);
        }
      }
      setLoadError(false);
      setLoadRequestVersion((current) => current + 1);
    }
    props.onActivate(src() ?? null);
  }

  const isHighlighted = () => props.active || props.selected;
  const buttonClass = () =>
    props.compact
      ? `group flex w-full min-w-0 flex-col gap-1.5 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
          isHighlighted()
            ? "border border-[var(--border-active)] bg-[var(--surface-active)]"
            : loadError()
              ? "border-red-500/40 bg-[var(--surface-subtle)]"
              : "border-[var(--border-subtle)] bg-[var(--surface-subtle)] hover:border-[var(--border)] hover:bg-[var(--surface-hover)] data-[pressed=true]:bg-[var(--surface-active)]"
        }`
      : `group flex w-full min-w-0 flex-col gap-1.5 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
          isHighlighted()
            ? "border border-[var(--border-active)] bg-[var(--surface-active)]"
            : loadError()
              ? "border-red-500/50 bg-[var(--surface-subtle)]"
              : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-hover)] data-[pressed=true]:bg-[var(--surface-active)]"
        }`;

  return (
    <div
      ref={(element) => {
        containerRef = element;
      }}
      class="relative w-full min-w-0"
    >
      <Button
        type="button"
        class={buttonClass()}
        onClick={handleClick}
        aria-pressed={isHighlighted() ? "true" : "false"}
      >
        <div class="relative aspect-square w-full overflow-hidden rounded-lg bg-[var(--surface)]">
          {!src() && !loadError() && props.offline && (
            <div class="flex h-full w-full items-center justify-center text-[var(--text-muted)]">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                class="h-8 w-8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" />
                <path d="M8 14.5 10.5 12l2 2 2-2 2.5 2.5" />
                <path d="M9 9.5h.01" />
              </svg>
            </div>
          )}
          {!src() && !loadError() && !props.offline && (
            <div class="h-full w-full animate-pulse bg-[var(--surface-hover)]" />
          )}
          {src() && (
            <img
              ref={imgRef}
              src={src()}
              alt={props.item.name}
              class="h-full w-full object-contain transition-opacity group-hover:opacity-90"
              loading="lazy"
            />
          )}
          {loadError() && (
            <div class="absolute inset-0 flex items-end justify-center rounded-lg bg-gradient-to-t from-black/80 to-transparent pb-3">
              <span class="text-[11px] font-medium text-red-400">Thumbnail failed</span>
            </div>
          )}
          <Show when={props.item.metadata.rating !== null}>
            <MediaRating
              rating={props.item.metadata.rating}
              readOnly
              class="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
            />
          </Show>
        </div>
        <div class="flex w-full min-w-0 items-center gap-1 px-0.5">
          <span
            class={`block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis text-[11px] font-medium ${isHighlighted() ? "text-[var(--text)]" : "text-[var(--text-faint)]"}`}
          >
            {props.item.name}
          </span>
          {props.item.metadata.hasSnapshots && (
            <div class="h-2 w-2 shrink-0 rounded-full bg-blue-400/90 shadow-sm" />
          )}
        </div>
      </Button>
      <Show when={props.showSelectionControls}>
        <button
          type="button"
          class={`absolute left-2.5 top-2.5 z-10 flex h-4 w-4 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
            props.selected
              ? "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text)]"
              : "border-white/45 bg-black/35 text-transparent hover:border-white/70"
          }`}
          aria-label={
            props.selected ? `Deselect ${props.item.name}` : `Select ${props.item.name}`
          }
          aria-pressed={props.selected ? "true" : "false"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onToggleSelection();
          }}
        >
          <span class="text-[9px] font-semibold leading-none">✓</span>
        </button>
      </Show>
    </div>
  );
};

export const MediaView: Component = () => {
  const [libraries, { refetch: refetchLibraries }] = createResource(listMediaLibraries);
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const [items, { refetch: refetchItems }] = createResource(
    selectedLibraryId,
    loadLibraryData,
  );
  const [cachedLibraryItems, { refetch: refetchCachedLibraryItems }] = createResource(
    selectedLibraryId,
    async (libraryId) => {
      if (!libraryId) {
        return [];
      }
      if (libraryId.startsWith("peer:")) {
        return applyStoredRatings(
          (await getCachedPeerLibraryItems(libraryId.slice("peer:".length))).map(
            peerMediaItem,
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
    },
  );
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [supportsS3Libraries, setSupportsS3Libraries] = createSignal(false);
  const [showS3Form, setShowS3Form] = createSignal(false);
  const [showLibraryActions, setShowLibraryActions] = createSignal(false);
  const [showAddDropdown, setShowAddDropdown] = createSignal(false);
  const [selectedMediaItemIds, setSelectedMediaItemIds] = createSignal<string[]>([]);
  const [filenameFilter, setFilenameFilter] = createSignal("");
  const [libraryOrder, setLibraryOrder] = createSignal<string[]>([]);
  const [s3Draft, setS3Draft] = createSignal<S3MediaLibraryInput>({
    name: "",
    endpoint: "",
    bucket: "",
    region: "us-east-1",
    access_key_id: "",
    secret_access_key: "",
    prefix: "",
  });
  const [error, setError] = createSignal<string | null>(null);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [libraryDropTarget, setLibraryDropTarget] = createSignal<{
    libraryIdx: number;
    position: "before" | "after";
  } | null>(null);
  // Scroll anchor: track the first visible item so scroll position can be
  // restored after column count changes (e.g. window resize or view switch).
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null);
  const [anchorRowOffset, setAnchorRowOffset] = createSignal(0);
  const [isScrolling, setIsScrolling] = createSignal(false);
  let scrollLabelTimeout: ReturnType<typeof setTimeout> | undefined;
  let libraryDragState: {
    pointerId: number;
    libraryIdx: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null = null;
  let suppressLibraryClickUntil = 0;
  const [uploadDragFeedback, setUploadDragFeedback] =
    createSignal<UploadDragFeedback | null>(null);
  const [uploadProgress, setUploadProgress] = createSignal<UploadProgress | null>(null);
  const [usesNativeDragDrop, setUsesNativeDragDrop] = createSignal(false);
  let isDisposed = false;
  let mediaShellRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let libraryTabsRef: HTMLDivElement | undefined;
  let libraryActionsRef: HTMLDivElement | undefined;
  let addDropdownRef: HTMLDivElement | undefined;
  let addDropdownMenuRef: HTMLDivElement | undefined;
  const [addDropdownPosition, setAddDropdownPosition] = createSignal<{
    left: number;
    top: number;
  } | null>(null);

  const clearLibraryDragState = () => {
    libraryDragState = null;
    setLibraryDropTarget(null);
  };

  const resolveLibraryDropIndex = (target: {
    libraryIdx: number;
    position: "before" | "after";
  }) => (target.position === "before" ? target.libraryIdx : target.libraryIdx + 1);

  const updateLibraryDropTargetFromPoint = (clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const target = element?.closest("[data-library-tab='true']");
    if (!(target instanceof HTMLButtonElement)) {
      setLibraryDropTarget(null);
      return;
    }
    const libraryIdxAttr = target.dataset.libraryIdx;
    if (!libraryIdxAttr) {
      throw new Error("library tab is missing an index");
    }
    const libraryIdx = Number(libraryIdxAttr);
    if (!Number.isInteger(libraryIdx)) {
      throw new Error("library tab index must be an integer");
    }
    const bounds = target.getBoundingClientRect();
    const isPinned = target.dataset.pinned === "true";
    const position =
      isPinned && clientX < bounds.left + bounds.width * 0.5
        ? "after"
        : clientX < bounds.left + bounds.width * 0.5
          ? "before"
          : "after";
    setLibraryDropTarget({ libraryIdx, position });
  };

  const getLibraryDropCursorStyle = () => {
    const container = libraryTabsRef;
    const target = libraryDropTarget();
    if (!container || !target) {
      return { opacity: 0 };
    }
    const tab = container.querySelector<HTMLButtonElement>(
      `[data-library-idx="${target.libraryIdx}"]`,
    );
    if (!(tab instanceof HTMLButtonElement)) {
      throw new Error("library drop target tab is missing");
    }
    const containerBounds = container.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    const left =
      (target.position === "before" ? tabBounds.left : tabBounds.right) -
      containerBounds.left -
      1.5;
    return {
      opacity: 1,
      left: `${left}px`,
      top: `${tabBounds.top - containerBounds.top}px`,
      height: `${tabBounds.height}px`,
    };
  };

  const startLibraryDrag = (event: PointerEvent, libraryIdx: number) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLButtonElement)) {
      throw new Error("library tab must be a button");
    }
    if (currentTarget.dataset.pinned === "true") {
      return;
    }
    currentTarget.setPointerCapture(event.pointerId);
    libraryDragState = {
      pointerId: event.pointerId,
      libraryIdx,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const commitLibraryDrop = async () => {
    const fromIdx = libraryDragState?.libraryIdx ?? null;
    const target = libraryDropTarget();
    clearLibraryDragState();
    if (fromIdx === null || target === null) {
      return;
    }
    const nextOrder = moveIdInOrder(
      libraryOrder(),
      fromIdx,
      resolveLibraryDropIndex(target),
    );
    await setMediaLibraryOrder(nextOrder);
    setLibraryOrder(nextOrder);
  };

  const handleLibraryPointerMove = (event: PointerEvent) => {
    const drag = libraryDragState;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = Math.abs(event.clientX - drag.startX);
    const deltaY = Math.abs(event.clientY - drag.startY);
    if (!drag.dragging) {
      if (Math.hypot(deltaX, deltaY) < 8) {
        return;
      }
      libraryDragState = { ...drag, dragging: true };
    }
    event.preventDefault();
    updateLibraryDropTargetFromPoint(event.clientX, event.clientY);
  };

  const handleLibraryPointerUp = (event: PointerEvent) => {
    const drag = libraryDragState;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const currentTarget = event.currentTarget;
    if (
      currentTarget instanceof HTMLButtonElement &&
      currentTarget.hasPointerCapture(event.pointerId)
    ) {
      currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.dragging) {
      event.preventDefault();
      suppressLibraryClickUntil = performance.now() + 750;
      void commitLibraryDrop();
      return;
    }
    clearLibraryDragState();
  };

  const handleLibraryPointerCancel = (event: PointerEvent) => {
    const currentTarget = event.currentTarget;
    if (
      currentTarget instanceof HTMLButtonElement &&
      currentTarget.hasPointerCapture(event.pointerId)
    ) {
      currentTarget.releasePointerCapture(event.pointerId);
    }
    clearLibraryDragState();
  };

  const discoveredPeerIds = createMemo(() =>
    p2pState.peers.map((peer) => peer.endpoint_id),
  );
  const onlinePeerIds = createMemo(() => new Set(discoveredPeerIds()));
  const libraryEntries = createMemo<LibraryEntry[]>(() => libraries() ?? []);
  const orderedLibraryEntries = createMemo(() => {
    const entries = libraryEntries();
    const order = mergeLibraryOrder(
      libraryOrder(),
      entries.map((library) => library.id),
    );
    const positions = new Map(order.map((id, index) => [id, index]));
    return [...entries].sort((left, right) => {
      const leftIndex = positions.get(left.id);
      const rightIndex = positions.get(right.id);
      if (leftIndex === undefined || rightIndex === undefined) {
        throw new Error("library order is missing a visible library id");
      }
      return leftIndex - rightIndex;
    });
  });
  const suggestedPeers = createMemo(() => {
    const addedPeerIds = new Set(
      libraryEntries()
        .filter(isPeerLibrary)
        .map((library) => peerLibraryPeerId(library)),
    );
    return p2pState.peers.filter((peer) => !addedPeerIds.has(peer.endpoint_id));
  });

  createEffect(() => {
    const availableLibraries = orderedLibraryEntries();
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

  createEffect(() => {
    if (canWriteSelectedLibrary()) {
      return;
    }
    setUploadDragFeedback(null);
  });

  createEffect(() => {
    const entries = libraryEntries();
    const nextOrder = mergeLibraryOrder(
      libraryOrder(),
      entries.map((library) => library.id),
    );
    if (
      nextOrder.length === libraryOrder().length &&
      nextOrder.every((id, index) => id === libraryOrder()[index])
    ) {
      return;
    }
    setLibraryOrder(nextOrder);
  });

  const selectedLibrary = createMemo(
    () =>
      orderedLibraryEntries().find((library) => library.id === selectedLibraryId()) ??
      null,
  );
  const activeMediaItemId = createMemo(() =>
    state.activeMediaLibraryId === selectedLibraryId() ? state.activeMediaItemId : null,
  );
  const selectedMediaItemIdSet = createMemo(() => new Set(selectedMediaItemIds()));
  const showSelectionControls = createMemo(() => selectedMediaItemIds().length > 0);
  const availableItems = createMemo(() => {
    const current = items();
    if (current?.libraryId === selectedLibraryId()) {
      return current.items;
    }
    return cachedLibraryItems() ?? [];
  });
  const activeFilenameFilter = createMemo(() =>
    state.currentView === "editor" ? [] : normalizeFilenameFilter(filenameFilter()),
  );
  const displayedItems = createMemo(() =>
    filterMediaItemsByFilename(availableItems(), activeFilenameFilter()),
  );
  const itemsById = createMemo(
    () => new Map(displayedItems().map((item) => [mediaItemKey(item), item])),
  );
  const isLibraryScanComplete = createMemo(() => {
    const current = items();
    if (!selectedLibraryId() || selectedLibraryId()?.startsWith("peer:")) {
      return true;
    }
    if (!current || current.libraryId !== selectedLibraryId()) {
      return false;
    }
    return current.isComplete;
  });
  const selectedLibraryDetail = createMemo(() => {
    const library = selectedLibrary();
    if (!library) {
      return "";
    }
    return isPeerLibrary(library) ? peerLibraryPeerId(library) : (library.path ?? "");
  });
  const selectedLibraryIsRefreshing = createMemo(() =>
    isLocalLibraryRefreshing(selectedLibrary()),
  );
  const selectedLibraryIsOffline = createMemo(() =>
    isLibraryOffline(selectedLibrary(), onlinePeerIds()),
  );
  const displayedError = createMemo(() => {
    if (selectedLibraryIsOffline()) {
      return null;
    }
    const current = items();
    if (current && current.libraryId === selectedLibraryId() && current.error) {
      return current.error;
    }
    return error();
  });
  const hasLibraries = createMemo(() => orderedLibraryEntries().length > 0);
  const canRefreshSelectedLibrary = createMemo(() => {
    const library = selectedLibrary();
    return (
      !!library &&
      !isPeerLibrary(library) &&
      !isCameraLibrary(library) &&
      !isS3Library(library) &&
      library.is_online !== false
    );
  });
  const canWriteSelectedLibrary = createMemo(() => libraryIsWritable(selectedLibrary()));
  const shouldDeferEditorStripThumbnails = createMemo(
    () => state.currentView === "editor" && isS3Library(selectedLibrary()),
  );
  const isUploadDragActive = createMemo(() => uploadDragFeedback() !== null);
  const uploadDragLabel = createMemo(() => {
    const feedback = uploadDragFeedback();
    if (!feedback) {
      return "";
    }
    if (feedback.itemCount === null) {
      return "Drop Files To Upload";
    }
    return feedback.itemCount === 1
      ? "Drop 1 File To Upload"
      : `Drop ${feedback.itemCount} Files To Upload`;
  });
  const uploadProgressPercent = createMemo(() => {
    const progress = uploadProgress();
    if (!progress) {
      return 0;
    }
    return Math.round((progress.completedFiles / progress.totalFiles) * 100);
  });
  const tileMinWidth = createMemo(() => {
    if (viewportWidth() < 640) {
      return 100;
    }
    return 160;
  });
  const columns = createMemo(() =>
    Math.max(1, Math.floor((viewportWidth() + GRID_GAP) / (tileMinWidth() + GRID_GAP))),
  );
  const tileWidth = createMemo(() => {
    const width = viewportWidth();
    const columnCount = columns();
    if (width <= 0) {
      return tileMinWidth();
    }
    return (width - GRID_GAP * (columnCount - 1)) / columnCount;
  });
  const tileRowHeight = createMemo(() => tileWidth() + TILE_LABEL_HEIGHT);
  const gridRows = createMemo<MediaGridRow[]>(() => {
    const rows: MediaGridRow[] = [];
    const currentColumns = columns();
    let lastDateKey: string | null = null;
    let currentRow: string[] = [];
    for (const item of displayedItems()) {
      const dateKey = modificationMonthKey(item.modifiedAt);
      if (lastDateKey !== dateKey) {
        if (currentRow.length > 0) {
          rows.push({ kind: "items", ids: currentRow });
          currentRow = [];
        }
        rows.push({ kind: "date", modifiedAt: item.modifiedAt });
        lastDateKey = dateKey;
      }
      currentRow.push(mediaItemKey(item));
      if (currentRow.length === currentColumns) {
        rows.push({ kind: "items", ids: currentRow });
        currentRow = [];
      }
    }
    if (currentRow.length > 0) {
      rows.push({ kind: "items", ids: currentRow });
    }
    return rows;
  });
  const stableGridRows = createMemo<MediaGridRow[]>((previous) => {
    const next = gridRows();
    if (!previous) return next;
    let allSame = next.length === previous.length;
    const result = next.map((row, i) => {
      const prev = previous[i];
      if (!prev || prev.kind !== row.kind) {
        allSame = false;
        return row;
      }
      if (row.kind === "date" && prev.kind === "date") {
        if (row.modifiedAt === prev.modifiedAt) return prev;
        allSame = false;
        return row;
      }
      if (row.kind === "items" && prev.kind === "items") {
        if (
          row.ids.length === prev.ids.length &&
          row.ids.every((id, j) => id === prev.ids[j])
        ) {
          return prev;
        }
        allSame = false;
        return row;
      }
      allSame = false;
      return row;
    });
    return allSame ? previous : result;
  });
  const rowOffsets = createMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const row of stableGridRows()) {
      offsets.push(offset);
      offset += row.kind === "date" ? HEADER_ROW_HEIGHT : tileRowHeight();
    }
    return offsets;
  });
  // Update the scroll anchor from a raw scrollTop value.
  // Finds the first visible items row and records its leading item ID
  // plus how many pixels the viewport top is into that row.
  const updateScrollAnchor = (top: number) => {
    const rows = untrack(stableGridRows);
    const offsets = untrack(rowOffsets);
    const rowHeight = untrack(tileRowHeight);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const height = row.kind === "date" ? HEADER_ROW_HEIGHT : rowHeight;
      if (offsets[i] + height > top) {
        if (row.kind === "items") {
          setAnchorItemId(row.ids[0]);
          setAnchorRowOffset(top - offsets[i]);
        } else {
          // Date header is at the top — anchor to the next items row instead
          for (let j = i + 1; j < rows.length; j++) {
            const next = rows[j];
            if (next.kind === "items") {
              setAnchorItemId(next.ids[0]);
              setAnchorRowOffset(0);
              break;
            }
          }
        }
        break;
      }
    }
  };

  // When the column count changes (resize / view switch), restore the scroll
  // position so the same media items remain visible.
  createEffect(
    on(columns, (_cols, prevCols) => {
      if (prevCols === undefined) return; // skip initial evaluation
      const anchor = untrack(anchorItemId);
      if (!anchor) return;
      const rows = untrack(stableGridRows);
      const offsets = untrack(rowOffsets);
      const rowHeight = untrack(tileRowHeight);
      const offset = untrack(anchorRowOffset);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.kind === "items" && row.ids.includes(anchor)) {
          const newTop = offsets[i] + Math.min(offset, rowHeight - 1);
          scrollRef.scrollTop = newTop;
          setScrollTop(newTop);
          break;
        }
      }
    }),
  );

  const totalHeight = createMemo(() => {
    const rows = stableGridRows();
    if (rows.length === 0) {
      return 0;
    }
    const offsets = rowOffsets();
    const lastRow = rows[rows.length - 1];
    return (
      offsets[offsets.length - 1] +
      (lastRow.kind === "date" ? HEADER_ROW_HEIGHT : tileRowHeight())
    );
  });
  const visibleRowRange = createMemo(() => {
    const rows = stableGridRows();
    const offsets = rowOffsets();
    const height = viewportHeight();
    const top = scrollTop();
    if (rows.length === 0 || height <= 0) {
      return { start: 0, end: 0 };
    }
    let start = 0;
    while (start < rows.length) {
      const rowTop = offsets[start];
      const rowBottom =
        rowTop + (rows[start].kind === "date" ? HEADER_ROW_HEIGHT : tileRowHeight());
      if (rowBottom >= top) {
        break;
      }
      start += 1;
    }
    let end = start;
    while (end < rows.length) {
      const rowTop = offsets[end];
      if (rowTop > top + height) {
        break;
      }
      end += 1;
    }
    return {
      start: Math.max(0, start - OVERSCAN_ROWS),
      end: Math.min(rows.length, end + OVERSCAN_ROWS),
    };
  });
  const visibleRows = createMemo(() =>
    stableGridRows().slice(visibleRowRange().start, visibleRowRange().end),
  );
  const offsetY = createMemo(() => rowOffsets()[visibleRowRange().start] ?? 0);
  const gridTemplateColumns = createMemo(() => `repeat(${columns()}, minmax(0, 1fr))`);

  const totalRows = createMemo(() => stableGridRows().length);

  const containerHeight = createMemo(() => {
    if (totalRows() === 0) {
      return 0;
    }
    return totalHeight();
  });

  // Label shown in the scroll landmark tooltip — the month/year of the anchor item.
  const scrollLabel = createMemo(() => {
    const id = anchorItemId();
    if (!id) return "";
    const item = itemsById().get(id);
    if (!item) return "";
    return formatModificationMonth(item.modifiedAt);
  });

  // Vertical position (px from top of scroll viewport) for the landmark tooltip,
  // tracking the scrollbar thumb center.
  const tooltipTop = createMemo(() => {
    const total = totalHeight();
    const viewport = viewportHeight();
    const top = scrollTop();
    if (total <= viewport || viewport <= 0) return viewport / 2;
    const thumbHeight = Math.max(40, (viewport * viewport) / total);
    const thumbRange = viewport - thumbHeight;
    const scrollRange = total - viewport;
    return Math.round((top / scrollRange) * thumbRange + thumbHeight / 2);
  });

  onMount(() => {
    startP2pPolling();
    void isTauriRuntime().then(setSupportsS3Libraries);
    void isTauriRuntime().then(async (isTauri) => {
      if (!isTauri) {
        return;
      }
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ peer_endpoint_id: string }>(
        "peer-paired",
        async () => {
          await refetchLibraries();
        },
      );
      onCleanup(() => {
        void unlisten();
      });
    });
    const libraryRefreshTimer = window.setInterval(() => {
      void Promise.resolve(refetchLibraries()).catch(() => undefined);
    }, 3000);
    const updateViewport = () => {
      setViewportHeight(scrollRef.clientHeight);
      setViewportWidth(scrollRef.clientWidth - 48);
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scrollRef);
    onCleanup(() => {
      isDisposed = true;
      window.clearInterval(libraryRefreshTimer);
      observer.disconnect();
      stopP2pPolling();
    });
  });

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        throw new Error("pointer event target must be a node");
      }
      if (showLibraryActions() && !libraryActionsRef?.contains(target)) {
        setShowLibraryActions(false);
      }
      if (
        showAddDropdown() &&
        !addDropdownRef?.contains(target) &&
        !addDropdownMenuRef?.contains(target)
      ) {
        setShowAddDropdown(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowLibraryActions(false);
        setShowAddDropdown(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  onMount(() => {
    let unlisten: (() => void) | null = null;
    let isUnmounted = false;
    void isTauriRuntime().then(async (tauriRuntime) => {
      if (!tauriRuntime || isUnmounted) {
        return;
      }
      setUsesNativeDragDrop(true);
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (!canWriteSelectedLibrary()) {
          setUploadDragFeedback(null);
          return;
        }
        if (event.payload.type === "leave") {
          setUploadDragFeedback(null);
          return;
        }
        if (event.payload.type === "enter") {
          setUploadDragFeedback({
            itemCount: draggedPathCount(event.payload.paths),
          });
          return;
        }
        if (event.payload.type === "over") {
          setUploadDragFeedback((current) => current ?? { itemCount: null });
          return;
        }
        setUploadDragFeedback(null);
        if (event.payload.paths.length === 0) {
          setError("drop did not contain files");
          return;
        }
        void handleUploadLibraryPaths(event.payload.paths);
      });
    });
    onCleanup(() => {
      isUnmounted = true;
      unlisten?.();
    });
  });

  createEffect(() => {
    selectedLibraryId();
    setScrollTop(0);
    setAnchorItemId(null);
    setAnchorRowOffset(0);
    setSelectedMediaItemIds([]);
    setShowLibraryActions(false);
    if (scrollRef) {
      scrollRef.scrollTop = 0;
    }
  });

  createEffect(() => {
    activeFilenameFilter();
    setScrollTop(0);
    setAnchorItemId(null);
    setAnchorRowOffset(0);
    if (scrollRef) {
      scrollRef.scrollTop = 0;
    }
  });

  createEffect(() => {
    const availableItemIds = new Set(displayedItems().map(mediaItemKey));
    setSelectedMediaItemIds((current) => {
      const next = current.filter((id) => availableItemIds.has(id));
      return next.length === current.length ? current : next;
    });
  });

  createEffect(() => {
    if (state.currentView !== "media" || !selectedLibraryId()) {
      return;
    }
    void refetchCachedLibraryItems();
    void refetchItems();
  });

  createEffect(() => {
    const libraryId = selectedLibraryId();
    const current = items();
    if (!libraryId || libraryId.startsWith("peer:")) {
      return;
    }
    if (
      items.loading ||
      !current ||
      current.libraryId !== libraryId ||
      (current.isComplete && !selectedLibraryIsRefreshing())
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (isDisposed) {
        return;
      }
      void Promise.resolve(refetchItems()).catch((error) => {
        setError(error instanceof Error ? error.message : String(error));
      });
    }, 300);
    onCleanup(() => clearTimeout(timer));
  });

  async function handleAddLibrary() {
    if (isSubmitting()) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const selectedPath = await pickDirectory();
      if (selectedPath === null) {
        return;
      }
      const library = await addMediaLibrary(selectedPath);
      await refetchLibraries();
      setSelectedLibraryId(library.id);
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateS3Draft<K extends keyof S3MediaLibraryInput>(
    key: K,
    value: S3MediaLibraryInput[K],
  ) {
    setS3Draft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function resetS3Draft() {
    setS3Draft({
      name: "",
      endpoint: "",
      bucket: "",
      region: "us-east-1",
      access_key_id: "",
      secret_access_key: "",
      prefix: "",
    });
  }

  async function handleAddS3Library() {
    if (isSubmitting()) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const library = await addS3MediaLibrary(s3Draft());
      resetS3Draft();
      setShowS3Form(false);
      await refetchLibraries();
      setSelectedLibraryId(library.id);
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAddPeerLibrary(peerId: string) {
    if (isSubmitting()) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await pairPeerDevice(peerId);
      const peer = p2pState.peers.find((entry) => entry.endpoint_id === peerId);
      if (!peer) {
        throw new Error("peer is no longer available");
      }
      await refetchLibraries();
      setSelectedLibraryId(`peer:${peerId}`);
      await refetchCachedLibraryItems();
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRemoveLibrary() {
    const library = selectedLibrary();
    if (!library?.removable) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      if (isPeerLibrary(library)) {
        await removeMediaLibrary(library.id);
        await removePeerLibrary(peerLibraryPeerId(library));
        await refetchLibraries();
        await refetchCachedLibraryItems();
        return;
      }
      await removeMediaLibrary(library.id);
      await refetchLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRefreshLibrary() {
    const library = selectedLibrary();
    if (
      !library ||
      isPeerLibrary(library) ||
      isCameraLibrary(library) ||
      isS3Library(library)
    ) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await refreshLibraryIndex(library.id);
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUploadLibraryFiles(
    files: File[],
    appendTimestampOnConflict = false,
  ) {
    const library = selectedLibrary();
    if (!libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (files.length === 0) {
      return;
    }
    if (isSubmitting()) {
      setError("media library operation already in progress");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: files.length,
          completedFiles: index,
          currentFileName: file.name,
        });
        await uploadMediaLibraryFile(library.id, file, appendTimestampOnConflict);
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: files.length,
        completedFiles: files.length,
        currentFileName: null,
      });
      await refetchCachedLibraryItems();
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadProgress(null);
      setIsSubmitting(false);
    }
  }

  async function handleUploadLibraryPaths(paths: string[]) {
    const library = selectedLibrary();
    if (!libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (paths.length === 0) {
      return;
    }
    if (isSubmitting()) {
      setError("media library operation already in progress");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      for (const [index, path] of paths.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: paths.length,
          completedFiles: index,
          currentFileName: path.split(/[/\\\\]/).pop() ?? path,
        });
        await uploadMediaLibraryPath(library.id, path);
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: paths.length,
        completedFiles: paths.length,
        currentFileName: null,
      });
      await refetchCachedLibraryItems();
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadProgress(null);
      setIsSubmitting(false);
    }
  }

  function handleUploadDragEnter(event: DragEvent) {
    if (usesNativeDragDrop() || !canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback({
      itemCount: draggedItemCount(event.dataTransfer),
    });
  }

  function handleUploadDragOver(event: DragEvent) {
    if (usesNativeDragDrop() || !canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    setUploadDragFeedback({
      itemCount: draggedItemCount(event.dataTransfer),
    });
  }

  function handleUploadDragLeave(event: DragEvent) {
    if (
      !canWriteSelectedLibrary() ||
      usesNativeDragDrop() ||
      (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
    ) {
      return;
    }
    setUploadDragFeedback(null);
  }

  function handleUploadDrop(event: DragEvent) {
    if (usesNativeDragDrop() || !canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback(null);
    const files = droppedFiles(event.dataTransfer);
    if (files.length === 0) {
      setError("drop did not contain files");
      return;
    }
    void handleUploadLibraryFiles(files);
  }

  function handleUploadPaste(event: ClipboardEvent) {
    if (!canWriteSelectedLibrary() || targetAcceptsTextInput(event.target)) {
      return;
    }
    let files: File[];
    try {
      files = clipboardImageFiles(event.clipboardData);
    } catch (error) {
      event.preventDefault();
      setError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void handleUploadLibraryFiles(files, true);
  }

  function toggleMediaSelection(itemId: string) {
    setSelectedMediaItemIds((current) =>
      current.includes(itemId)
        ? current.filter((candidate) => candidate !== itemId)
        : [...current, itemId],
    );
  }

  async function handleOpenItem(item: MediaItem, libraryId: string, src: string | null) {
    setSelectedMediaItemIds([]);
    setError(null);
    try {
      await openMediaItem(item, libraryId, src);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpenSelectedItems() {
    const libraryId = selectedLibraryId();
    if (!libraryId) {
      throw new Error("cannot open selected media without a library");
    }
    const itemIds = selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    setError(null);
    try {
      for (const [index, itemId] of itemIds.entries()) {
        const item = itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        await openMediaItem(item, libraryId, null, index === 0 ? "replace" : "append");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteSelectedItems() {
    if (!canWriteSelectedLibrary()) {
      throw new Error("selected library is readonly");
    }
    const itemIds = selectedMediaItemIds();
    if (itemIds.length === 0) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      for (const itemId of itemIds) {
        const item = itemsById().get(itemId);
        if (!item) {
          throw new Error(`selected media item not found: ${itemId}`);
        }
        if (item.kind !== "local") {
          throw new Error(`media item is not deletable: ${itemId}`);
        }
        await deleteMediaLibraryItem(item.path);
      }
      setSelectedMediaItemIds([]);
      await refetchCachedLibraryItems();
      await refetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const isEditorStrip = () => state.currentView === "editor";
  const mediaVisibleClass = () => (isEditorStrip() ? "hidden lg:flex" : "flex");
  const shellClass = () =>
    isEditorStrip()
      ? "hidden w-[112px] shrink-0 border-r border-[var(--border)] bg-[var(--panel-bg)] lg:flex lg:flex-col"
      : "flex flex-1 flex-col overflow-hidden pt-[calc(env(safe-area-inset-top)+3.5rem)] lg:pt-0";
  const scrollClass = () =>
    isEditorStrip()
      ? "media-scroll h-full overflow-y-auto px-2 py-3"
      : "media-scroll h-full overflow-y-auto p-4 md:p-6";

  const hasImage = () => state.canvasWidth > 0 || state.isLoading;
  
  return (
    <section
      ref={mediaShellRef}
      tabIndex={-1}
      aria-label="Media view"
      data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
      class={`${shellClass()} mobile-slider-fade outline-none relative transition-opacity duration-150`}
      onDragEnter={handleUploadDragEnter}
      onDragOver={handleUploadDragOver}
      onDragLeave={handleUploadDragLeave}
      onDrop={handleUploadDrop}
      onPaste={handleUploadPaste}
      onPointerDown={(event) => {
        if (targetUsesOwnFocus(event.target)) {
          return;
        }
        mediaShellRef?.focus();
      }}
    >
      <Show when={isUploadDragActive()}>
        <div class="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border border-dashed border-[var(--border-active)] bg-[color-mix(in_srgb,var(--surface-active)_68%,transparent)]">
          <div class="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-active)] bg-[var(--panel-bg)] px-5 py-4 text-center shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
            <div class="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text)]">
              {uploadDragLabel()}
            </div>
            <p class="text-[12px] font-medium text-[var(--text-dim)]">
              {selectedLibrary()?.name ?? "Selected library"}
            </p>
          </div>
        </div>
      </Show>
      <Show when={!isEditorStrip()}>
        <div
          class={`${mediaVisibleClass()} border-b border-[var(--border)] px-4 py-4 md:px-6`}
        >
          <div class="flex w-full flex-wrap items-center gap-3">
            <div
              ref={libraryTabsRef}
              class="relative gap-2 flex flex-1 overflow-x-auto"
            >
              <div
                aria-hidden="true"
                class="pointer-events-none absolute z-10 w-[3px] rounded-full bg-blue-400 shadow-[0_0_0_3px_rgba(96,165,250,0.18)]"
                style={getLibraryDropCursorStyle()}
              />
              <For each={orderedLibraryEntries()}>
                {(library, libraryIdx) => {
                  const offline = isLibraryOffline(library, onlinePeerIds());
                  const refreshing = isLocalLibraryRefreshing(library);
                  const pinned = isPinnedLibrary(library);
                  return (
                    <Button
                      type="button"
                      data-library-tab="true"
                      data-library-idx={String(libraryIdx())}
                      data-pinned={pinned ? "true" : "false"}
                      onClick={(event) => {
                        if (performance.now() < suppressLibraryClickUntil) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        setSelectedLibraryId(library.id);
                      }}
                      onPointerDown={(event) => startLibraryDrag(event, libraryIdx())}
                      onPointerMove={pinned ? undefined : handleLibraryPointerMove}
                      onPointerUp={pinned ? undefined : handleLibraryPointerUp}
                      onPointerCancel={pinned ? undefined : handleLibraryPointerCancel}
                      class={`${LIBRARY_TAB_BASE_CLASS} ${
                        selectedLibraryId() === library.id
                          ? offline
                            ? "border-dashed border-amber-400/45 bg-[var(--surface-active)] text-[var(--text)]"
                            : "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text)]"
                          : offline
                            ? "border-dashed border-amber-500/25 bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-amber-400/40 hover:text-[var(--text)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-medium)] hover:text-[var(--text)]"
                      }`}
                    >
                      <span class="flex items-center gap-2">
                        {(isPeerLibrary(library) ||
                          isCameraLibrary(library) ||
                          isS3Library(library) ||
                          refreshing ||
                          offline) && (
                          <span
                            class={`h-1.5 w-1.5 rounded-full ${
                              refreshing
                                ? "animate-pulse bg-sky-400"
                                : offline
                                  ? "bg-amber-400"
                                  : "bg-emerald-400"
                            }`}
                          />
                        )}
                        <span class="block max-w-[140px] overflow-hidden text-ellipsis">{library.name}</span>
                      </span>
                    </Button>
                  );
                }}
              </For>
              <For each={suggestedPeers()}>
                {(peer) => (
                  <Button
                    type="button"
                    class={`${LIBRARY_TAB_BASE_CLASS} w-full border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)] md:w-auto`}
                    disabled={isSubmitting()}
                    onClick={() => void handleAddPeerLibrary(peer.endpoint_id)}
                  >
                    <span class="block max-w-[140px] overflow-hidden text-ellipsis">{peer.name}</span>
                  </Button>
                )}
              </For>
              <div class="hidden md:flex relative shrink-0 items-center" ref={addDropdownRef}>
                <Button
                  type="button"
                  class={`${LIBRARY_TAB_BASE_CLASS} w-full border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] px-3 text-[14px] leading-none text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)] md:w-auto`}
                  disabled={isSubmitting()}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setAddDropdownPosition({
                      left: rect.left,
                      top: rect.bottom,
                    });
                    setShowAddDropdown((current) => !current);
                  }}
                  onClick={() => {
                    void handleAddLibrary();
                  }}
                  aria-label="Add library"
                >
                  +
                </Button>
              </div>
            </div>
            <Show when={showAddDropdown() && addDropdownPosition()}>
              <Portal>
                <div
                  ref={addDropdownMenuRef}
                  role="menu"
                  class="fixed z-50 min-w-36 rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.18)]"
                  style={{
                    left: `${addDropdownPosition()?.left}px`,
                    top: `${addDropdownPosition()?.top + 8}px`,
                  }}
                >
                  <Button
                    type="button"
                    role="menuitem"
                    class={MENU_ITEM_BUTTON_CLASS}
                    disabled={isSubmitting()}
                    onClick={() => {
                      setShowAddDropdown(false);
                      void handleAddLibrary();
                    }}
                  >
                    Directory
                  </Button>
                  <Show when={supportsS3Libraries()}>
                    <Button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM_BUTTON_CLASS}
                      disabled={isSubmitting()}
                      onClick={() => {
                        setShowAddDropdown(false);
                        setShowS3Form((current) => !current);
                      }}
                    >
                      S3
                    </Button>
                  </Show>
                </div>
              </Portal>
            </Show>
            <div class="relative flex items-center" ref={libraryActionsRef}>
              <Show when={selectedLibrary()}>
                <label class="hidden md:block w-full w-56">
                  <input
                    type="text"
                    value={filenameFilter()}
                    onInput={(event) => setFilenameFilter(event.currentTarget.value)}
                    class={INPUT_CLASS}
                    placeholder="Search names or tags"
                    aria-label="Search names or tags"
                  />
                </label>
              </Show>
              
              <Button
                type="button"
                class={`${SURFACE_BUTTON_CLASS} min-w-8 px-2 text-[14px] leading-none`}
                disabled={isSubmitting() || !selectedLibrary()}
                aria-label="Library actions"
                aria-haspopup="menu"
                aria-expanded={showLibraryActions() ? "true" : "false"}
                onClick={() => setShowLibraryActions((current) => !current)}
              >
                •••
              </Button>
              <Show when={showLibraryActions()}>
                <div
                  role="menu"
                  class="absolute right-0 top-full z-10 mt-2 min-w-36 rounded-lg border border-[var(--border-medium)] bg-[var(--panel-bg)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.18)]"
                >
                  <Button
                    type="button"
                    role="menuitem"
                    class={MENU_ITEM_BUTTON_CLASS}
                    disabled={!canRefreshSelectedLibrary() || isSubmitting()}
                    onClick={() => {
                      setShowLibraryActions(false);
                      void handleRefreshLibrary();
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    type="button"
                    role="menuitem"
                    class={MENU_DANGER_ITEM_BUTTON_CLASS}
                    disabled={!selectedLibrary()?.removable || isSubmitting()}
                    onClick={() => {
                      setShowLibraryActions(false);
                      void handleRemoveLibrary();
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </Show>
            </div>
            <Show when={showS3Form()}>
              <div class="grid grid-cols-1 gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 md:grid-cols-3">
                <div class="md:col-span-3">
                  <div class={PANEL_SECTION_TITLE_CLASS}>S3 Library</div>
                </div>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Name</span>
                  <input
                    type="text"
                    value={(s3Draft().name as string | undefined) ?? ""}
                    onInput={(event) => updateS3Draft("name", event.currentTarget.value)}
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1 md:col-span-2">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Endpoint</span>
                  <input
                    type="text"
                    value={s3Draft().endpoint}
                    onInput={(event) =>
                      updateS3Draft("endpoint", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                    placeholder="https://s3.example.com"
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Bucket</span>
                  <input
                    type="text"
                    value={s3Draft().bucket}
                    onInput={(event) =>
                      updateS3Draft("bucket", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Region</span>
                  <input
                    type="text"
                    value={s3Draft().region}
                    onInput={(event) =>
                      updateS3Draft("region", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Prefix</span>
                  <input
                    type="text"
                    value={(s3Draft().prefix as string | undefined) ?? ""}
                    onInput={(event) =>
                      updateS3Draft("prefix", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                    placeholder="optional/path"
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Access Key ID</span>
                  <input
                    type="text"
                    value={s3Draft().access_key_id}
                    onInput={(event) =>
                      updateS3Draft("access_key_id", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1 md:col-span-2">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Secret Access Key</span>
                  <input
                    type="password"
                    value={s3Draft().secret_access_key}
                    onInput={(event) =>
                      updateS3Draft("secret_access_key", event.currentTarget.value)
                    }
                    class={INPUT_CLASS}
                  />
                </label>
                <div class="flex items-end gap-2 md:col-span-3">
                  <Button
                    type="button"
                    class={SURFACE_BUTTON_CLASS}
                    disabled={isSubmitting()}
                    onClick={() => void handleAddS3Library()}
                  >
                    Add S3 Library
                  </Button>
                  <Button
                    type="button"
                    class="h-8 px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-faint)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                    disabled={isSubmitting()}
                    onClick={() => {
                      resetS3Draft();
                      setShowS3Form(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      <div class="relative flex-1 min-h-0">
        <Show when={hasImage() && state.currentView === "editor"}>
          <div class="px-3 pt-3 pb-2 w-full">
            <ActionButton
              label="Back"
              icon={
                <svg
                  width="24px"
                  height="24px"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  class="h-4 w-4"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              }
              onClick={() => {
                showMediaView();
              }}
            />
          </div>
        </Show>
      
        <div
          ref={scrollRef}
          class={scrollClass()}
          onScroll={(event) => {
            const top = event.currentTarget.scrollTop;
            setScrollTop(top);
            updateScrollAnchor(top);
            setIsScrolling(true);
            clearTimeout(scrollLabelTimeout);
            scrollLabelTimeout = setTimeout(() => setIsScrolling(false), 1000);
          }}
        >
          <Show
            when={displayedItems().length > 0}
            fallback={
              <Show
                when={hasLibraries()}
                fallback={
                  <Show
                    when={!isEditorStrip()}
                    fallback={
                      <div class={`${EMPTY_STATE_CLASS} mx-1 text-xs`}>
                        Open the media view to add your first library.
                      </div>
                    }
                  >
                    <div class={EMPTY_STATE_PANEL_CLASS}>
                      <div class="space-y-1">
                        <p class={PANEL_SECTION_TITLE_CLASS}>Media Library</p>
                        <h2 class="text-lg font-semibold text-[var(--text)]">
                          Add your first library
                        </h2>
                      </div>
                      <p class="max-w-sm text-sm leading-6 text-[var(--text-dim)]">
                        Pick a folder with your images. Shade will index it and show it
                        here in the media view.
                      </p>
                      <Button
                        type="button"
                        class={SURFACE_BUTTON_CLASS}
                        disabled={isSubmitting()}
                        onClick={() => void handleAddLibrary()}
                      >
                        Add Library
                      </Button>
                      <p class="text-xs text-[var(--text-faint)]">
                        You can also use the + button in the library bar.
                      </p>
                    </div>
                  </Show>
                }
              >
                <Show
                  when={selectedLibraryIsOffline()}
                  fallback={
                    <Show
                      when={items.loading || !isLibraryScanComplete()}
                      fallback={
                        <div
                          class={`${EMPTY_STATE_CLASS} ${
                            isEditorStrip() ? "mx-1 text-xs" : "text-sm"
                          }`}
                        >
                          {activeFilenameFilter().length > 0
                            ? `No media match "${filenameFilter().trim()}".`
                            : `No images found in ${selectedLibrary()?.name ?? "this library"}.`}
                        </div>
                      }
                    >
                      <div
                        class={`mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl px-6 py-8 text-center ${
                          isEditorStrip() ? "mx-1 text-xs" : "text-sm"
                        }`}
                      >
                        <div class="flex h-14 w-14 items-center justify-center rounded-2xl text-[var(--text-muted)]">
                          <div class="relative h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-medium)] border-t-[var(--text-muted)]">
                            <div class="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[var(--text-muted)]" />
                          </div>
                        </div>
                        <div class="space-y-1">
                          <h2 class="text-sm font-semibold text-[var(--text)]">
                            Loading library
                          </h2>
                          <p class="max-w-sm text-sm leading-6 text-[var(--text-dim)]">
                            Indexing images and restoring cached items.
                          </p>
                        </div>
                      </div>
                    </Show>
                  }
                >
                  <div
                    class={`mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl px-6 py-8 text-center ${
                      isEditorStrip() ? "mx-1 text-xs" : "text-sm"
                    }`}
                  >
                    <div class="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border-medium)] bg-[var(--surface)] text-[var(--text-muted)]">
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        class="h-7 w-7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" />
                        <path d="M7.5 14.5 10 12l2 2 2-2 2.5 2.5" />
                        <path d="M8 9.5h.01" />
                        <path d="M5 19 19 5" />
                      </svg>
                    </div>
                    <div class="space-y-1">
                      <h2 class="text-sm font-semibold text-[var(--text)]">
                        This library is currently offline
                      </h2>
                      <p class="max-w-sm text-sm leading-6 text-[var(--text-dim)]">
                        Reconnect it to browse the images that are already cached.
                      </p>
                    </div>
                  </div>
                </Show>
              </Show>
            }
          >
            <Show
              when={!isEditorStrip()}
              fallback={
                <div style={{ height: `${containerHeight()}px`, position: "relative" }}>
                  <div
                    class="grid gap-x-0 gap-y-1"
                    style={{
                      "grid-template-columns": gridTemplateColumns(),
                      transform: `translateY(${offsetY()}px)`,
                    }}
                  >
                    <For each={visibleRows()}>
                      {(row) =>
                        row.kind === "date" ? (
                          <h2 class="col-span-full px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)] first:pt-0">
                            {formatModificationMonth(row.modifiedAt)}
                          </h2>
                        ) : (
                          <For each={row.ids}>
                            {(id) => {
                              const item = itemsById().get(id);
                              return (
                                item && (
                                  <MediaTile
                                    item={item}
                                    compact
                                    offline={selectedLibraryIsOffline()}
                                    disableThumbnailLoad={shouldDeferEditorStripThumbnails()}
                                    active={activeMediaItemId() === id}
                                    selected={selectedMediaItemIdSet().has(id)}
                                    showSelectionControls={showSelectionControls()}
                                    onActivate={(src) => {
                                      const libraryId = selectedLibraryId();
                                      if (!libraryId) {
                                        throw new Error("selected library is required");
                                      }
                                      void handleOpenItem(item, libraryId, src);
                                    }}
                                    onToggleSelection={() => toggleMediaSelection(id)}
                                  />
                                )
                              );
                            }}
                          </For>
                        )
                      }
                    </For>
                  </div>
                </div>
              }
            >
              <div style={{ height: `${containerHeight()}px`, position: "relative" }}>
                <div
                  class="grid gap-1"
                  style={{
                    "grid-template-columns": gridTemplateColumns(),
                    transform: `translateY(${offsetY()}px)`,
                  }}
                >
                  <For each={visibleRows()}>
                    {(row) =>
                      row.kind === "date" ? (
                        <h2 class="col-span-full pt-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)] first:pt-0">
                          {formatModificationMonth(row.modifiedAt)}
                        </h2>
                      ) : (
                        <For each={row.ids}>
                          {(id) => {
                            const item = itemsById().get(id);
                            return (
                              item && (
                                <MediaTile
                                  item={item}
                                  offline={selectedLibraryIsOffline()}
                                  active={activeMediaItemId() === id}
                                  selected={selectedMediaItemIdSet().has(id)}
                                  showSelectionControls={showSelectionControls()}
                                  onActivate={(src) => {
                                    const libraryId = selectedLibraryId();
                                    if (!libraryId) {
                                      throw new Error("selected library is required");
                                    }
                                    void handleOpenItem(item, libraryId, src);
                                  }}
                                  onToggleSelection={() => toggleMediaSelection(id)}
                                />
                              )
                            );
                          }}
                        </For>
                      )
                    }
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </div>
        <Show when={isScrolling() && scrollLabel()}>
          <div
            class={`pointer-events-none absolute ${
              isEditorStrip()
                ? "right-0 translate-x-[calc(100%+0.5rem)] text-left"
                : "right-4"
            } z-20 -translate-y-1/2 rounded-md bg-[var(--panel-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)] shadow-md ring-1 ring-[var(--border-medium)]`}
            style={{ top: `${tooltipTop()}px` }}
          >
            {scrollLabel()}
          </div>
        </Show>
      </div>

      <div
        class={`hidden flex-col gap-2 border-t border-[var(--border)] ${
          isEditorStrip() ? "" : "md:flex px-4 py-3 md:px-6"
        }`}
      >
        {displayedError() && (
          <p class="text-sm text-[var(--danger-text)]">{displayedError()}</p>
        )}
        <Show when={selectedMediaItemIds().length > 0}>
          <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] font-medium text-[var(--text-dim)]">
              {selectedMediaItemIds().length} selected
            </p>
            <div class="flex items-center gap-2">
              <Button
                type="button"
                class={SURFACE_BUTTON_CLASS}
                onClick={() => void handleOpenSelectedItems()}
              >
                Open Selected
              </Button>
              <Show when={canWriteSelectedLibrary()}>
                <Button
                  type="button"
                  class={DANGER_BUTTON_CLASS}
                  disabled={isSubmitting()}
                  onClick={() => void handleDeleteSelectedItems()}
                >
                  Delete Selected
                </Button>
              </Show>
              <Button
                type="button"
                class={SURFACE_BUTTON_CLASS}
                onClick={() => setSelectedMediaItemIds([])}
              >
                Clear
              </Button>
            </div>
          </div>
        </Show>
        <Show when={selectedLibraryDetail()}>
          <p class="overflow-hidden whitespace-nowrap text-ellipsis text-[11px] font-medium text-[var(--text-dim)]">
            {selectedLibraryDetail()}
            {selectedLibraryIsOffline() && " • offline"}
            {selectedLibraryIsRefreshing() && " • refreshing library index"}
            {!selectedLibraryIsRefreshing() &&
              !selectedLibraryIsOffline() &&
              !isLibraryScanComplete() &&
              ` • indexing ${availableItems().length} images`}
          </p>
        </Show>
      </div>
      
      <Show when={selectedLibrary()}>
        <div class="fixed left-0 right-0 w-auto bottom-[env(safe-area-inset-bottom)] px-7 md:hidden">
          <input
            type="text"
            value={filenameFilter()}
            onInput={(event) => setFilenameFilter(event.currentTarget.value)}
            class={INPUT_CLASS}
            placeholder="Search names or tags"
            aria-label="Search names or tags"
          />
        </div>
      </Show>
      
      <Show when={uploadProgress()}>
        {(progress) => (
          <div class="pointer-events-none absolute bottom-4 right-4 z-30 w-[min(20rem,calc(100%-2rem))] rounded-xl border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--panel-bg)_92%,transparent)] px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md">
            <div class="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text)]">
              <span>
                {progress().phase === "uploading" ? "Uploading" : "Refreshing Library"}
              </span>
              <span class="text-[var(--text-dim)]">
                {progress().completedFiles}/{progress().totalFiles}
              </span>
            </div>
            <Show when={progress().currentFileName}>
              <p class="mt-1 overflow-hidden whitespace-nowrap text-ellipsis text-[12px] font-medium text-[var(--text-dim)]">
                {progress().currentFileName}
              </p>
            </Show>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]">
              <div
                class="h-full rounded-full bg-[var(--border-active)] transition-[width] duration-150"
                style={{ width: `${uploadProgressPercent()}%` }}
              />
            </div>
          </div>
        )}
      </Show>
    </section>
  );
};
