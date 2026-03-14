import { open } from "@tauri-apps/plugin-dialog";
import { Component, createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, Suspense } from "solid-js";
import {
  addMediaLibrary,
  getPeerThumbnail,
  listLibraryImages,
  listMediaLibraries,
  listPeerPictures,
  removeMediaLibrary,
  type MediaLibrary,
  type SharedPicture,
} from "../bridge/index";
import { resolveMediaSrc } from "../media-source";
import { openImage, openPeerImage, state } from "../store/editor";
import { p2pState, startP2pPolling, stopP2pPolling } from "../store/p2p";

type PeerLibrary = {
  id: string;
  kind: "peer";
  name: string;
  path: null;
  removable: true;
  peerId: string;
};

type LibraryEntry = MediaLibrary | PeerLibrary;

type MediaItem =
  | { kind: "local"; id: string; name: string; path: string }
  | { kind: "peer"; id: string; name: string; peerId: string };

const TILE_MIN_WIDTH = 160;
const GRID_GAP = 12;
const TILE_LABEL_HEIGHT = 24;
const OVERSCAN_ROWS = 2;

function peerLibraryId(peerId: string) {
  return `peer:${peerId}`;
}

function peerLibraryName(peerId: string) {
  return `Peer ${peerId.slice(0, 8)}`;
}

function shortPeerId(peerId: string) {
  if (peerId.length <= 18) {
    return peerId;
  }
  return `${peerId.slice(0, 8)}...${peerId.slice(-8)}`;
}

function isPeerLibrary(library: LibraryEntry | null): library is PeerLibrary {
  return library?.kind === "peer";
}

function pictureName(path: string) {
  return path.split("/").pop() ?? path;
}

function localMediaItem(path: string): MediaItem {
  return {
    kind: "local",
    id: path,
    name: pictureName(path),
    path,
  };
}

async function loadLibraryItems(libraryId: string | null): Promise<MediaItem[]> {
  if (!libraryId) {
    return [];
  }
  if (libraryId.startsWith("peer:")) {
    const peerId = libraryId.slice("peer:".length);
    const pictures = await listPeerPictures(peerId);
    return pictures.map((picture) => ({
      kind: "peer",
      id: picture.id,
      name: picture.name,
      peerId,
    }));
  }
  const paths = await listLibraryImages(libraryId);
  return paths.map(localMediaItem);
}

async function loadItemSrc(item: MediaItem, signal: AbortSignal): Promise<string> {
  if (item.kind === "peer") {
    if (signal.aborted) {
      throw new DOMException("thumbnail load aborted", "AbortError");
    }
    return getPeerThumbnail(item.peerId, item.id);
  }
  return resolveMediaSrc(item.path, signal);
}

async function openMediaItem(item: MediaItem, src: string | null) {
  if (item.kind === "peer") {
    const picture: SharedPicture = { id: item.id, name: item.name };
    await openPeerImage(item.peerId, picture, src);
    return;
  }
  await openImage(item.path, src);
}

const ImageTile: Component<{ item: MediaItem }> = (props) => {
  const [isIntersecting, setIsIntersecting] = createSignal(false);
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  const [loadError, setLoadError] = createSignal(false);
  let containerRef: HTMLButtonElement | undefined;
  let imgRef: HTMLImageElement | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setIsIntersecting(entry.isIntersecting);
    }, { rootMargin: "200px" });
    if (containerRef) observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!isIntersecting() || src()) {
      return;
    }
    const controller = new AbortController();
    setLoadError(false);
    void loadItemSrc(props.item, controller.signal)
      .then((nextSrc) => setSrc(nextSrc))
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadError(true);
        errorTimer = setTimeout(() => setLoadError(false), 4000);
      });
    onCleanup(() => controller.abort());
  });

  onCleanup(() => {
    const url = src();
    if (url?.startsWith("blob:") && url !== state.loadingMediaSrc) {
      URL.revokeObjectURL(url);
    }
    clearTimeout(errorTimer);
  });

  function handleClick() {
    setLoadError(false);
    if (imgRef) {
      imgRef.style.viewTransitionName = "active-media";
    }

    const handleError = () => {
      setLoadError(true);
      errorTimer = setTimeout(() => setLoadError(false), 4000);
    };

    const currentSrc = src() ?? null;
    if (document.startViewTransition) {
      document.startViewTransition(() => void openMediaItem(props.item, currentSrc).catch(handleError));
      return;
    }
    void openMediaItem(props.item, currentSrc).catch(handleError);
  }

  return (
    <button
      type="button"
      ref={containerRef}
      class={`group flex flex-col gap-1.5 rounded-xl text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
        loadError() ? "ring-1 ring-red-500/50" : "hover:bg-white/[0.06]"
      }`}
      onClick={handleClick}
    >
      <div class="relative aspect-square w-full overflow-hidden rounded-lg bg-white/[0.04]">
        {!src() && !loadError() && <div class="h-full w-full animate-pulse bg-white/[0.06]" />}
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
            <span class="text-[11px] font-medium text-red-400">Failed to open</span>
          </div>
        )}
      </div>
      <span class="truncate px-0.5 text-[11px] text-white/40">{props.item.name}</span>
    </button>
  );
};

export const MediaView: Component = () => {
  const [libraries, { refetch: refetchLibraries }] = createResource(listMediaLibraries);
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const [peerLibraries, setPeerLibraries] = createSignal<PeerLibrary[]>([]);
  const [items, { refetch: refetchItems }] = createResource(selectedLibraryId, loadLibraryItems);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  let scrollRef!: HTMLDivElement;

  const discoveredPeerIds = createMemo(() => p2pState.peers.map((peer) => peer.endpoint_id));
  const libraryEntries = createMemo<LibraryEntry[]>(() => [...(libraries() ?? []), ...peerLibraries()]);
  const suggestedPeers = createMemo(() => {
    const addedPeerIds = new Set(peerLibraries().map((library) => library.peerId));
    return p2pState.peers.filter((peer) => !addedPeerIds.has(peer.endpoint_id));
  });

  createEffect(() => {
    const peerIds = new Set(discoveredPeerIds());
    setPeerLibraries((current) => current.filter((library) => peerIds.has(library.peerId)));
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
    setSelectedLibraryId(availableLibraries[0].id);
  });

  const selectedLibrary = createMemo(() => (
    libraryEntries().find((library) => library.id === selectedLibraryId()) ?? null
  ));
  const selectedLibraryDetail = createMemo(() => {
    const library = selectedLibrary();
    if (!library) {
      return "";
    }
    return isPeerLibrary(library) ? library.peerId : library.path ?? "";
  });
  const columns = createMemo(() => Math.max(1, Math.floor((viewportWidth() + GRID_GAP) / (TILE_MIN_WIDTH + GRID_GAP))));
  const tileWidth = createMemo(() => {
    const width = viewportWidth();
    const columnCount = columns();
    if (width <= 0) {
      return TILE_MIN_WIDTH;
    }
    return (width - GRID_GAP * (columnCount - 1)) / columnCount;
  });
  const rowHeight = createMemo(() => tileWidth() + TILE_LABEL_HEIGHT);
  const totalRows = createMemo(() => Math.ceil((items()?.length ?? 0) / columns()));
  const visibleRowRange = createMemo(() => {
    const height = viewportHeight();
    const currentRowHeight = rowHeight();
    if (height <= 0 || currentRowHeight <= 0) {
      return { start: 0, end: 0 };
    }
    const start = Math.max(0, Math.floor(scrollTop() / currentRowHeight) - OVERSCAN_ROWS);
    const end = Math.min(
      totalRows(),
      Math.ceil((scrollTop() + height) / currentRowHeight) + OVERSCAN_ROWS,
    );
    return { start, end };
  });
  const visibleItems = createMemo(() => {
    const allItems = items() ?? [];
    const { start, end } = visibleRowRange();
    const startIdx = start * columns();
    const endIdx = Math.min(allItems.length, end * columns());
    return allItems.slice(startIdx, endIdx);
  });
  const offsetY = createMemo(() => visibleRowRange().start * rowHeight());

  onMount(() => {
    startP2pPolling();
    const updateViewport = () => {
      setViewportHeight(scrollRef.clientHeight);
      setViewportWidth(scrollRef.clientWidth - 48);
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scrollRef);
    onCleanup(() => {
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
      await listPeerPictures(peerId);
      const nextLibrary: PeerLibrary = {
        id: peerLibraryId(peerId),
        kind: "peer",
        name: peerLibraryName(peerId),
        path: null,
        removable: true,
        peerId,
      };
      setPeerLibraries((current) => {
        if (current.some((library) => library.peerId === peerId)) {
          return current;
        }
        return [...current, nextLibrary];
      });
      setSelectedLibraryId(nextLibrary.id);
      await refetchItems();
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
        setPeerLibraries((current) => current.filter((entry) => entry.id !== library.id));
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
      <div class="border-b border-white/6 px-6 py-4">
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-3">
            <h1 class="text-sm font-medium text-white/80">Media</h1>
            <p class="truncate font-mono text-xs text-white/40">
              {shortPeerId(p2pState.local_endpoint_id || "starting")}
            </p>
          </div>
          <div class="flex items-center gap-8">
            <h1 class="hidden text-sm font-medium text-white/80 md:block">Libraries</h1>
            <div class="flex flex-1 gap-2 overflow-x-auto">
              <For each={libraryEntries()}>
                {(library) => (
                  <button
                    type="button"
                    onClick={() => setSelectedLibraryId(library.id)}
                    class={`shrink-0 rounded-full border px-4 py-2 text-[12px] font-semibold transition-colors ${
                      selectedLibraryId() === library.id
                        ? "border-white/18 bg-white/12 text-white"
                        : "border-white/8 bg-white/[0.03] text-white/55 hover:border-white/12 hover:text-white"
                    }`}
                  >
                    {library.name}
                  </button>
                )}
              </For>
              <For each={suggestedPeers()}>
                {(peer) => (
                  <button
                    type="button"
                    class="shrink-0 rounded-full border border-dashed border-white/14 bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-white/60 transition-colors hover:border-white/24 hover:text-white"
                    disabled={isSubmitting()}
                    onClick={() => void handleAddPeerLibrary(peer.endpoint_id)}
                  >
                    {peerLibraryName(peer.endpoint_id)}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="shrink-0 rounded-full border border-dashed border-white/14 bg-white/[0.03] px-3 py-2 text-[14px] font-semibold leading-none text-white/60 transition-colors hover:border-white/24 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
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
                class="rounded-full border border-red-500/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-300 transition-colors hover:border-red-400/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!selectedLibrary()?.removable || isSubmitting()}
                onClick={() => void handleRemoveLibrary()}
              >
                Remove
              </button>
            </div>
          </div>
          {error() && <p class="text-sm text-red-300">{error()}</p>}
          <Show when={selectedLibraryDetail()}>
            <p class="truncate text-xs text-white/28">{selectedLibraryDetail()}</p>
          </Show>
        </div>
      </div>
      <div
        ref={scrollRef!}
        class="media-scroll flex-1 overflow-y-auto p-6"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <Suspense fallback={<p class="text-sm text-white/30">Loading…</p>}>
          <Show
            when={(items()?.length ?? 0) > 0}
            fallback={<p class="text-sm text-white/30">No images found in {selectedLibrary()?.name ?? "this library"}.</p>}
          >
            <div style={{ height: `${totalRows() * rowHeight()}px`, position: "relative" }}>
              <div
                class="grid gap-3"
                style={{
                  "grid-template-columns": `repeat(${columns()}, minmax(0, 1fr))`,
                  transform: `translateY(${offsetY()}px)`,
                }}
              >
                <For each={visibleItems()}>
                  {(item) => <ImageTile item={item} />}
                </For>
              </div>
            </div>
          </Show>
        </Suspense>
      </div>
    </div>
  );
};
