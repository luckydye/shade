import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Button } from "./Button";
import { MediaRating } from "./MediaRating";
import {
  addS3MediaLibrary,
  addMediaLibrary,
  isTauriRuntime,
  listMediaRatings,
  pickDirectory,
  refreshLibraryIndex,
  type LibraryImage,
  listMediaLibraries,
  removeMediaLibrary,
  type MediaLibrary,
  type S3MediaLibraryInput,
  type SharedPicture,
} from "../bridge/index";
import {
  getCachedCameraLibraryItems,
  loadCameraLibraryItemsCachedOrRemote,
  resetCameraThumbnailFailure,
  resolveCameraThumbnailSrc,
} from "../camera-library-cache";
import {
  addPeerLibrary,
  getCachedPeerLibraryItems,
  listPeerLibraries,
  loadPeerLibraryItemsCachedOrRemote,
  removePeerLibrary,
  resolvePeerThumbnailSrc,
  type PeerLibrary,
  type PeerLibraryItem,
} from "../peer-library-cache";
import {
  getCachedLocalLibraryItems,
  loadLocalLibraryItemsCachedOrRemote,
  resetLocalThumbnailFailure,
  resolveLocalThumbnailSrc,
} from "../local-library-cache";
import {
  openImage,
  openPeerImage,
  setTransitionMediaSrc,
  state,
  transitionMediaSrc,
} from "../store/editor";
import { p2pState, startP2pPolling, stopP2pPolling } from "../store/p2p";

type LibraryEntry = MediaLibrary | PeerLibrary;

type MediaItemMetadata = {
  hasSnapshots: boolean;
  baseRating: number | null;
  rating: number | null;
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

const TILE_MIN_WIDTH = 160;
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
const INPUT_CLASS =
  "h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const EMPTY_STATE_CLASS =
  "rounded-lg border border-dashed border-[var(--border-medium)] bg-[var(--surface-subtle)] px-3 py-4 text-sm text-[var(--text-faint)]";
const LIBRARY_TAB_BASE_CLASS =
  "inline-flex h-7 shrink-0 items-center rounded-full border px-4 text-[12px] font-semibold tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";

function isPeerLibrary(library: LibraryEntry | null): library is PeerLibrary {
  return library?.kind === "peer";
}

function isLocalLibraryRefreshing(library: LibraryEntry | null) {
  return (
    !!library &&
    !isPeerLibrary(library) &&
    library.kind === "directory" &&
    library.is_refreshing
  );
}

function isLibraryOffline(
  library: LibraryEntry | null,
  onlinePeerIds: Set<string>,
) {
  if (!library) {
    return false;
  }
  if (isPeerLibrary(library)) {
    return !onlinePeerIds.has(library.peerId);
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

function cameraLibraryHost(libraryId: string) {
  if (!libraryId.startsWith("ccapi:")) {
    throw new Error(`invalid camera library id: ${libraryId}`);
  }
  return libraryId.slice("ccapi:".length);
}

function pictureName(path: string) {
  return path.split("/").pop() ?? path;
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
      baseRating: normalizeRating(image.metadata?.rating),
      rating: normalizeRating(image.metadata?.rating),
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
    metadata: { hasSnapshots: false, baseRating: null, rating: null },
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
    return resolveCameraThumbnailSrc(item.path, signal);
  }
  return resolveLocalThumbnailSrc(item.path, signal);
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
    if (!isIntersecting() || src() || isLoadingSrc) {
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
    if (url?.startsWith("blob:") && url !== state.loadingMediaSrc && url !== transitionMediaSrc()) {
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
    const clearViewTransitionName = () => {
      if (!imgRef) {
        return;
      }
      imgRef.style.viewTransitionName = "";
    };
    if (imgRef) {
      imgRef.style.viewTransitionName = "active-media";
    }

    const handleError = () => {
      setLoadError(true);
    };

    const currentSrc = src() ?? null;
    if (document.startViewTransition) {
      setTransitionMediaSrc(currentSrc);
      const transition = document.startViewTransition(() => {
        props.onActivate(currentSrc);
        clearViewTransitionName();
      });
      void transition.finished.finally(() => {
        clearViewTransitionName();
        setTransitionMediaSrc(null);
      });
      return;
    }
    setTransitionMediaSrc(null);
    try {
      props.onActivate(currentSrc);
    } catch {
      handleError();
    } finally {
      clearViewTransitionName();
    }
  }

  const isHighlighted = () => props.active || props.selected;
  const buttonClass = () =>
    props.compact
      ? `group flex w-full min-w-0 flex-col gap-1.5 rounded-md border p-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
          isHighlighted()
            ? "border-[var(--border-active)] bg-[var(--surface-active)]"
            : loadError()
              ? "border-red-500/40 bg-[var(--surface-subtle)]"
              : "border-[var(--border-subtle)] bg-[var(--surface-subtle)] hover:border-[var(--border)] hover:bg-[var(--surface-hover)] data-[pressed=true]:bg-[var(--surface-active)]"
        }`
      : `group flex w-full min-w-0 flex-col gap-1.5 rounded-md border p-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
          isHighlighted()
            ? "border-[var(--border-active)] bg-[var(--surface-active)]"
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
          {!src() && !loadError() && (
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
      <button
        type="button"
        class={`absolute left-2.5 top-2.5 z-10 flex h-4 w-4 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
          props.selected
            ? "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text)]"
            : "border-white/45 bg-black/35 text-transparent hover:border-white/70"
        }`}
        aria-label={props.selected ? `Deselect ${props.item.name}` : `Select ${props.item.name}`}
        aria-pressed={props.selected ? "true" : "false"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onToggleSelection();
        }}
      >
        <span class="text-[9px] font-semibold leading-none">✓</span>
      </button>
    </div>
  );
};

export const MediaView: Component = () => {
  const [libraries, { refetch: refetchLibraries }] = createResource(listMediaLibraries);
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const [peerLibraries, { mutate: setPeerLibraries, refetch: refetchPeerLibraries }] =
    createResource(listPeerLibraries);
  const [items, { refetch: refetchItems }] = createResource(
    selectedLibraryId,
    loadLibraryData,
  );
  const [cachedLibraryItems, { refetch: refetchCachedLibraryItems }] =
    createResource(
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
  const [selectedMediaItemIds, setSelectedMediaItemIds] = createSignal<string[]>([]);
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
  let isDisposed = false;
  let scrollRef!: HTMLDivElement;

  const discoveredPeerIds = createMemo(() =>
    p2pState.peers.map((peer) => peer.endpoint_id),
  );
  const onlinePeerIds = createMemo(() => new Set(discoveredPeerIds()));
  const libraryEntries = createMemo<LibraryEntry[]>(() => [
    ...(libraries() ?? []),
    ...(peerLibraries() ?? []),
  ]);
  const suggestedPeers = createMemo(() => {
    const addedPeerIds = new Set(
      (peerLibraries() ?? []).map((library) => library.peerId),
    );
    return p2pState.peers.filter((peer) => !addedPeerIds.has(peer.endpoint_id));
  });

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

  const selectedLibrary = createMemo(
    () => libraryEntries().find((library) => library.id === selectedLibraryId()) ?? null,
  );
  const activeMediaItemId = createMemo(() =>
    state.activeMediaLibraryId === selectedLibraryId() ? state.activeMediaItemId : null,
  );
  const selectedMediaItemIdSet = createMemo(() => new Set(selectedMediaItemIds()));
  const displayedItems = createMemo(() => {
    const current = items();
    if (current?.libraryId === selectedLibraryId()) {
      return current.items;
    }
    return cachedLibraryItems() ?? [];
  });
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
  createEffect(() => {
    const current = items();
    if (!current || current.libraryId !== selectedLibraryId()) {
      return;
    }
    setError(current.error);
  });
  const selectedLibraryDetail = createMemo(() => {
    const library = selectedLibrary();
    if (!library) {
      return "";
    }
    return isPeerLibrary(library) ? library.peerId : (library.path ?? "");
  });
  const selectedLibraryIsRefreshing = createMemo(() =>
    isLocalLibraryRefreshing(selectedLibrary()),
  );
  const selectedLibraryIsOffline = createMemo(() =>
    isLibraryOffline(selectedLibrary(), onlinePeerIds()),
  );
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
  const columns = createMemo(() =>
    Math.max(1, Math.floor((viewportWidth() + GRID_GAP) / (TILE_MIN_WIDTH + GRID_GAP))),
  );
  const tileWidth = createMemo(() => {
    const width = viewportWidth();
    const columnCount = columns();
    if (width <= 0) {
      return TILE_MIN_WIDTH;
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

  onMount(() => {
    startP2pPolling();
    void refetchPeerLibraries();
    void isTauriRuntime().then(setSupportsS3Libraries);
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

  createEffect(() => {
    selectedLibraryId();
    setScrollTop(0);
    setSelectedMediaItemIds([]);
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
      const nextLibrary = await addPeerLibrary(peerId);
      setPeerLibraries((current) => {
        const libraries = current ?? [];
        if (libraries.some((library) => library.peerId === peerId)) {
          return libraries;
        }
        return [...libraries, nextLibrary];
      });
      setSelectedLibraryId(nextLibrary.id);
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
        await removePeerLibrary(library.peerId);
        setPeerLibraries((current) =>
          (current ?? []).filter((entry) => entry.id !== library.id),
        );
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
    if (!library || isPeerLibrary(library) || isCameraLibrary(library) || isS3Library(library)) {
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

  const isEditorStrip = () => state.currentView === "editor";
  const mediaVisibleClass = () => (isEditorStrip() ? "hidden lg:flex" : "flex");
  const shellClass = () =>
    isEditorStrip()
      ? "hidden w-[112px] shrink-0 border-r border-[var(--border)] bg-[var(--panel-bg)] lg:flex lg:flex-col"
      : "mt-[calc(env(safe-area-inset-top)+3.5rem)] flex flex-1 flex-col overflow-hidden md:mt-0";
  const scrollClass = () =>
    isEditorStrip()
      ? "media-scroll flex-1 overflow-y-auto px-2 py-3"
      : "media-scroll flex-1 overflow-y-auto p-4 md:p-6";

  return (
    <div class={shellClass()}>
      <Show when={!isEditorStrip()}>
        <div class={`${mediaVisibleClass()} border-b border-[var(--border)] px-4 py-3 md:px-6`}>
          <div class="flex w-full items-center gap-3">
            <div class="flex flex-1 gap-2 overflow-x-auto">
                <For each={libraryEntries()}>
                  {(library) =>
                    (() => {
                      const offline = isLibraryOffline(library, onlinePeerIds());
                      const refreshing = isLocalLibraryRefreshing(library);
                      return (
                        <Button
                          type="button"
                          onClick={() => setSelectedLibraryId(library.id)}
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
                            <span>{library.name}</span>
                          </span>
                        </Button>
                      );
                    })()
                  }
                </For>
                <For each={suggestedPeers()}>
                  {(peer) => (
                    <Button
                      type="button"
                      class={`${LIBRARY_TAB_BASE_CLASS} border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)]`}
                      disabled={isSubmitting()}
                      onClick={() => void handleAddPeerLibrary(peer.endpoint_id)}
                    >
                      {`Peer ${peer.endpoint_id.slice(0, 8)}`}
                    </Button>
                  )}
                </For>
                <Button
                  type="button"
                  class={`${LIBRARY_TAB_BASE_CLASS} border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] px-3 text-[14px] leading-none text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)]`}
                  disabled={isSubmitting()}
                  onClick={() => void handleAddLibrary()}
                  aria-label="Add library"
                >
                  +
                </Button>
                <Show when={supportsS3Libraries()}>
                  <Button
                    type="button"
                    class={`${LIBRARY_TAB_BASE_CLASS} border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)]`}
                    disabled={isSubmitting()}
                    onClick={() => setShowS3Form((current) => !current)}
                  >
                    S3
                  </Button>
                </Show>
            </div>
            <div class="flex items-center gap-2">
              <Button
                type="button"
                class={SURFACE_BUTTON_CLASS}
                disabled={!canRefreshSelectedLibrary() || isSubmitting()}
                onClick={() => void handleRefreshLibrary()}
              >
                Refresh
              </Button>
              <Button
                type="button"
                class={DANGER_BUTTON_CLASS}
                disabled={!selectedLibrary()?.removable || isSubmitting()}
                onClick={() => void handleRemoveLibrary()}
              >
                Remove
              </Button>
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
                    onInput={(event) => updateS3Draft("endpoint", event.currentTarget.value)}
                    class={INPUT_CLASS}
                    placeholder="https://s3.example.com"
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Bucket</span>
                  <input
                    type="text"
                    value={s3Draft().bucket}
                    onInput={(event) => updateS3Draft("bucket", event.currentTarget.value)}
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Region</span>
                  <input
                    type="text"
                    value={s3Draft().region}
                    onInput={(event) => updateS3Draft("region", event.currentTarget.value)}
                    class={INPUT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class={PANEL_SECTION_TITLE_CLASS}>Prefix</span>
                  <input
                    type="text"
                    value={(s3Draft().prefix as string | undefined) ?? ""}
                    onInput={(event) => updateS3Draft("prefix", event.currentTarget.value)}
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
      <div
        ref={scrollRef!}
        class={scrollClass()}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <Show
          when={displayedItems().length > 0}
          fallback={
            <div
              class={`${EMPTY_STATE_CLASS} ${
                isEditorStrip() ? "mx-1 text-xs" : "text-sm"
              }`}
            >
              {items.loading || !isLibraryScanComplete()
                ? "Loading…"
                : `No images found in ${selectedLibrary()?.name ?? "this library"}.`}
            </div>
          }
        >
          <Show
            when={!isEditorStrip()}
            fallback={
              <div class="flex flex-col gap-2">
                <For each={displayedItems()}>
                  {(item) => (
                    <MediaTile
                      item={item}
                      compact
                      active={activeMediaItemId() === mediaItemKey(item)}
                      selected={selectedMediaItemIdSet().has(mediaItemKey(item))}
                      onActivate={(src) =>
                        void handleOpenItem(item, selectedLibraryId()!, src)
                      }
                      onToggleSelection={() => toggleMediaSelection(mediaItemKey(item))}
                    />
                  )}
                </For>
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
                                active={activeMediaItemId() === id}
                                selected={selectedMediaItemIdSet().has(id)}
                                onActivate={(src) =>
                                  void handleOpenItem(item, selectedLibraryId()!, src)
                                }
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

      <div
        class={`flex flex-col gap-2 border-t border-[var(--border)] ${
          isEditorStrip() ? "px-3 py-2" : "px-4 py-3 md:px-6"
        }`}
      >
        {error() && <p class="text-sm text-[var(--danger-text)]">{error()}</p>}
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
              ` • indexing ${displayedItems().length} images`}
          </p>
        </Show>
      </div>
    </div>
  );
};
