import { open } from "@tauri-apps/plugin-dialog";
import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  addMediaLibrary,
  type LibraryImage,
  listMediaLibraries,
  removeMediaLibrary,
  type MediaLibrary,
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
import { openImage, openPeerImage, state } from "../store/editor";
import { p2pState, startP2pPolling, stopP2pPolling } from "../store/p2p";

type LibraryEntry = MediaLibrary | PeerLibrary;

type MediaItemMetadata = {
  hasSnapshots: boolean;
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

const TILE_MIN_WIDTH = 160;
const GRID_GAP = 12;
const TILE_LABEL_HEIGHT = 24;
const HEADER_ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 2;

function shortPeerId(peerId: string) {
  if (peerId.length <= 18) {
    return peerId;
  }
  return `${peerId.slice(0, 8)}...${peerId.slice(-8)}`;
}

function isPeerLibrary(library: LibraryEntry | null): library is PeerLibrary {
  return library?.kind === "peer";
}

function isCameraLibrary(
  library: LibraryEntry | null,
): library is MediaLibrary & { kind: "camera" } {
  return library?.kind === "camera";
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
    metadata: { hasSnapshots: image.metadata?.has_snapshots ?? false },
  };
}

function peerMediaItem(image: PeerLibraryItem): MediaItem {
  return {
    kind: "peer",
    id: image.id,
    name: image.name,
    peerId: image.peerId,
    modifiedAt: normalizeModifiedAt(image.modified_at),
    metadata: { hasSnapshots: false },
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
    return (await loadPeerLibraryItemsCachedOrRemote(peerId)).map(peerMediaItem);
  }
  if (libraryId.startsWith("ccapi:")) {
    return (await loadCameraLibraryItemsCachedOrRemote(cameraLibraryHost(libraryId))).map(
      localMediaItem,
    );
  }
  return (await loadLocalLibraryItemsCachedOrRemote(libraryId)).items.map(localMediaItem);
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
      items: listing.items.map(localMediaItem),
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

async function openMediaItem(item: MediaItem, src: string | null) {
  if (item.kind === "peer") {
    const picture: SharedPicture = {
      id: item.id,
      name: item.name,
      modified_at: item.modifiedAt,
    };
    await openPeerImage(item.peerId, picture, src);
    return;
  }
  await openImage(item.path, src);
}

const ImageTile: Component<{ item: MediaItem }> = (props) => {
  const [isIntersecting, setIsIntersecting] = createSignal(false);
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  const [loadError, setLoadError] = createSignal(false);
  const [loadRequestVersion, setLoadRequestVersion] = createSignal(0);
  let containerRef: HTMLButtonElement | undefined;
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
    if (url?.startsWith("blob:") && url !== state.loadingMediaSrc) {
      URL.revokeObjectURL(url);
    }
  });

  function handleClick() {
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
    if (imgRef) {
      imgRef.style.viewTransitionName = "active-media";
    }

    const handleError = () => {
      setLoadError(true);
    };

    const currentSrc = src() ?? null;
    if (document.startViewTransition) {
      document.startViewTransition(
        () => void openMediaItem(props.item, currentSrc).catch(handleError),
      );
      return;
    }
    void openMediaItem(props.item, currentSrc).catch(handleError);
  }

  return (
    <button
      type="button"
      ref={containerRef}
      class={`group flex flex-col gap-1.5 p-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
        loadError() ? "ring-1 ring-red-500/50" : "hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
      }`}
      onClick={handleClick}
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
        {props.item.metadata.hasSnapshots && (
          <div class="absolute bottom-1.5 right-1.5 h-2 w-2 rounded-full bg-blue-400/90 shadow-sm" />
        )}
      </div>
      <span class="truncate px-0.5 text-[11px] text-[var(--text-faint)]">{props.item.name}</span>
    </button>
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
  const [cachedLibraryItems, { refetch: refetchCachedLibraryItems }] = createResource(
    selectedLibraryId,
    async (libraryId) => {
      if (!libraryId) {
        return [];
      }
      if (libraryId.startsWith("peer:")) {
        return (await getCachedPeerLibraryItems(libraryId.slice("peer:".length))).map(
          peerMediaItem,
        );
      }
      if (libraryId.startsWith("ccapi:")) {
        return (await getCachedCameraLibraryItems(cameraLibraryHost(libraryId))).map(
          localMediaItem,
        );
      }
      return (await getCachedLocalLibraryItems(libraryId)).map(localMediaItem);
    },
  );
  const [isSubmitting, setIsSubmitting] = createSignal(false);
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
    if (scrollRef) {
      scrollRef.scrollTop = 0;
    }
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
      current.isComplete
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (isDisposed) {
        return;
      }
      void Promise.resolve(refetchItems()).catch((error) => {
        console.warn("failed to refresh media library items", error);
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
      const selectedPath = await open({
        directory: true,
        multiple: false,
      });
      if (selectedPath === null) {
        return;
      }
      if (Array.isArray(selectedPath)) {
        throw new Error("expected a single directory path");
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

  return (
    <div class="mt-[calc(env(safe-area-inset-top)+3.5rem)] flex flex-1 flex-col overflow-hidden md:mt-0">
      <div class="border-b border-[var(--border)] px-6 py-4">
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-8">
            <h1 class="hidden text-sm font-medium text-[var(--text-secondary)] md:block">Libraries</h1>
            <div class="flex flex-1 gap-2 overflow-x-auto">
              <For each={libraryEntries()}>
                {(library) =>
                  (() => {
                    const offline = isPeerLibrary(library)
                      ? !onlinePeerIds().has(library.peerId)
                      : isCameraLibrary(library)
                        ? library.is_online === false
                        : false;
                    return (
                      <button
                        type="button"
                        onClick={() => setSelectedLibraryId(library.id)}
                        class={`shrink-0 rounded-full border px-4 py-2 text-[12px] font-semibold transition-colors ${
                          selectedLibraryId() === library.id
                            ? offline
                              ? "border-dashed border-amber-400/45 bg-[var(--surface-active)] text-[var(--text)]"
                              : "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text)]"
                            : offline
                              ? "border-dashed border-amber-500/25 bg-[var(--surface-faint)] text-[var(--text-muted)] hover:border-amber-400/40 hover:text-[var(--text)]"
                              : "border-[var(--border-soft)] bg-[var(--surface-faint)] text-[var(--text-muted)] hover:border-[var(--border-medium)] hover:text-[var(--text)]"
                        }`}
                      >
                        <span class="flex items-center gap-2">
                          {(isPeerLibrary(library) || isCameraLibrary(library)) && (
                            <span
                              class={`h-1.5 w-1.5 rounded-full ${
                                offline ? "bg-amber-400" : "bg-emerald-400"
                              }`}
                            />
                          )}
                          <span>{library.name}</span>
                        </span>
                      </button>
                    );
                  })()
                }
              </For>
              <For each={suggestedPeers()}>
                {(peer) => (
                  <button
                    type="button"
                    class="shrink-0 rounded-full border border-dashed border-[var(--border-dashed)] bg-[var(--surface-faint)] px-4 py-2 text-[12px] font-semibold text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:text-[var(--text)]"
                    disabled={isSubmitting()}
                    onClick={() => void handleAddPeerLibrary(peer.endpoint_id)}
                  >
                    {`Peer ${peer.endpoint_id.slice(0, 8)}`}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="shrink-0 rounded-full border border-dashed border-[var(--border-dashed)] bg-[var(--surface-faint)] px-3 py-2 text-[14px] font-semibold leading-none text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isSubmitting()}
                onClick={() => void handleAddLibrary()}
                aria-label="Add library"
              >
                +
              </button>
            </div>
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="rounded-full border border-[var(--danger-border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--danger-text)] transition-colors hover:border-[var(--danger-hover-border)] hover:text-[var(--danger-hover-text)] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!selectedLibrary()?.removable || isSubmitting()}
                onClick={() => void handleRemoveLibrary()}
              >
                Remove
              </button>
            </div>
          </div>
          {error() && <p class="text-sm text-[var(--danger-text)]">{error()}</p>}
          <Show when={selectedLibraryDetail()}>
            <p class="truncate text-xs text-[var(--text-dim)]">
              {selectedLibraryDetail()}
              {!isLibraryScanComplete() &&
                ` • indexing ${displayedItems().length} images`}
            </p>
          </Show>
        </div>
      </div>
      <div
        ref={scrollRef!}
        class="media-scroll flex-1 overflow-y-auto p-6"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <Show
          when={displayedItems().length > 0}
          fallback={
            <p class="text-sm text-[var(--text-subtle)]">
              {items.loading || !isLibraryScanComplete()
                ? "Loading…"
                : `No images found in ${selectedLibrary()?.name ?? "this library"}.`}
            </p>
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
                    <h2 class="col-span-full pt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-faint)] first:pt-0">
                      {formatModificationMonth(row.modifiedAt)}
                    </h2>
                  ) : (
                    <For each={row.ids}>
                      {(id) => {
                        const item = itemsById().get(id);
                        return item && <ImageTile item={item} />;
                      }}
                    </For>
                  )
                }
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};
