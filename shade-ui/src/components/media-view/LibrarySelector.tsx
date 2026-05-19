import type { Component, JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useLibrarySyncProgress } from "../../data/use-library-sync-progress";
import { useMediaLibraryList } from "../../data/use-media-library-list";
import { usePeerDiscovery } from "../../data/use-peer-discovery";
import type { S3MediaLibraryInput } from "../../types";
import { isTauriRuntime } from "../../utils";
import { Button } from "../Button";
import {
  isCameraLibrary,
  isLibraryOffline,
  isLocalLibraryRefreshing,
  isPeerLibrary,
  isPinnedLibrary,
  isS3Library,
  mergeLibraryOrder,
  moveIdInOrder,
  peerLibraryPeerId,
} from "./media-utils";
import { useMediaViewStore } from "./media-view-store";
import {
  PICTURE_GRID_ZOOM_LEVELS,
  pictureGridZoomIndex,
  zoomPictureGridIn,
  zoomPictureGridOut,
} from "./picture-grid-state";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const LibrarySelector: Component = () => {
  const store = useMediaViewStore();
  const {
    addMediaLibrary,
    addS3MediaLibrary,
    getS3MediaLibrary,
    refreshLibraryIndex,
    removeMediaLibrary,
    removePeerLibrary,
    setLibraryMode,
    setMediaLibraryOrder,
    syncLibrary,
    updateS3MediaLibrary,
    pickDirectory,
  } = useMediaLibraryList();
  const { peers: discoveredPeers, pairPeerDevice } = usePeerDiscovery();
  const syncProgress = useLibrarySyncProgress();

  const [supportsS3Libraries, setSupportsS3Libraries] = createSignal(false);
  const [showS3Form, setShowS3Form] = createSignal(false);
  const [editingS3LibraryId, setEditingS3LibraryId] = createSignal<string | null>(null);
  const [showLibraryActions, setShowLibraryActions] = createSignal(false);
  const [showAddDropdown, setShowAddDropdown] = createSignal(false);
  const [addDropdownPosition, setAddDropdownPosition] = createSignal<{
    left: number;
    top: number;
  } | null>(null);
  const [libraryOrder, setLibraryOrder] = createSignal<string[]>([]);
  const [libraryDropTarget, setLibraryDropTarget] = createSignal<{
    libraryIdx: number;
    position: "before" | "after";
  } | null>(null);
  const [s3Draft, setS3Draft] = createSignal<S3MediaLibraryInput>({
    name: "",
    endpoint: "",
    bucket: "",
    region: "us-east-1",
    access_key_id: "",
    secret_access_key: "",
    prefix: "",
  });

  let libraryTabsRef: HTMLDivElement | undefined;
  let libraryActionsRef: HTMLDivElement | undefined;
  let addDropdownRef: HTMLDivElement | undefined;
  let addDropdownMenuRef: HTMLDivElement | undefined;
  let suppressLibraryClickUntil = 0;
  let libraryDragState: {
    pointerId: number;
    libraryIdx: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null = null;

  const discoveredPeerIds = createMemo(() =>
    discoveredPeers().map((peer) => peer.endpoint_id),
  );
  const onlinePeerIds = createMemo(() => new Set(discoveredPeerIds()));
  const orderedLibraryEntries = createMemo(() => {
    const order = mergeLibraryOrder(
      libraryOrder(),
      store.libraryEntries().map((library) => library.id),
    );
    const positions = new Map(order.map((id, index) => [id, index]));
    return [...store.libraryEntries()].sort((left, right) => {
      const leftIndex = positions.get(left.id);
      const rightIndex = positions.get(right.id);
      if (leftIndex === undefined || rightIndex === undefined) {
        throw new Error("library order is missing a visible library id");
      }
      return leftIndex - rightIndex;
    });
  });
  const selectedLibrary = createMemo(
    () =>
      orderedLibraryEntries().find(
        (library) => library.id === store.selectedLibraryId(),
      ) ?? null,
  );
  const suggestedPeers = createMemo(() => {
    const addedPeerIds = new Set(
      store
        .libraryEntries()
        .filter(isPeerLibrary)
        .map((library) => peerLibraryPeerId(library)),
    );
    return discoveredPeers().filter((peer) => !addedPeerIds.has(peer.endpoint_id));
  });
  const canRefreshSelectedLibrary = createMemo(() => {
    const library = selectedLibrary();
    if (!library) return false;
    if (isS3Library(library)) return true;
    return (
      !isPeerLibrary(library) && !isCameraLibrary(library) && library.is_online !== false
    );
  });
  const syncTargets = () =>
    orderedLibraryEntries().filter(
      (lib) =>
        lib.id !== selectedLibrary()?.id && (lib.kind === "s3" || lib.kind === "peer"),
    );

  createEffect(() => {
    const nextOrder = mergeLibraryOrder(
      libraryOrder(),
      store.libraryEntries().map((library) => library.id),
    );
    if (
      nextOrder.length === libraryOrder().length &&
      nextOrder.every((id, index) => id === libraryOrder()[index])
    ) {
      return;
    }
    setLibraryOrder(nextOrder);
  });

  onMount(() => {
    setSupportsS3Libraries(isTauriRuntime());
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
      if (event.defaultPrevented) return;
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

  async function withSubmitting(fn: () => Promise<void>) {
    if (store.isSubmitting()) return;
    store.setIsSubmitting(true);
    store.setError(null);
    try {
      await fn();
    } catch (err) {
      store.setError(toErrorMessage(err));
    } finally {
      store.setIsSubmitting(false);
    }
  }

  function updateS3Draft<K extends keyof S3MediaLibraryInput>(
    key: K,
    value: S3MediaLibraryInput[K],
  ) {
    setS3Draft((current) => ({ ...current, [key]: value }));
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

  function closeS3Form() {
    resetS3Draft();
    setEditingS3LibraryId(null);
    setShowS3Form(false);
  }

  function openAddS3Form() {
    resetS3Draft();
    setEditingS3LibraryId(null);
    setShowS3Form(true);
  }

  async function openEditS3Form() {
    const library = selectedLibrary();
    if (!library || !isS3Library(library)) {
      return;
    }
    await withSubmitting(async () => {
      const draft = await getS3MediaLibrary(library.id);
      setS3Draft({
        ...draft,
        name: draft.name ?? "",
        prefix: draft.prefix ?? "",
      });
      setEditingS3LibraryId(library.id);
      setShowS3Form(true);
    });
  }

  async function handleAddLibrary() {
    await withSubmitting(async () => {
      const selectedPath = await pickDirectory();
      if (selectedPath === null) return;
      const library = await addMediaLibrary(selectedPath);
      await store.refetchLibraries();
      store.setSelectedLibraryId(library.id);
      await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
    });
  }

  async function handleSubmitS3Library() {
    await withSubmitting(async () => {
      const editingLibraryId = editingS3LibraryId();
      const library = editingLibraryId
        ? await updateS3MediaLibrary(editingLibraryId, s3Draft())
        : await addS3MediaLibrary(s3Draft());
      closeS3Form();
      await store.refetchLibraries();
      store.setSelectedLibraryId(library.id);
      await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
    });
  }

  async function handleAddPeerLibrary(peerId: string) {
    await withSubmitting(async () => {
      await pairPeerDevice(peerId);
      const peer = discoveredPeers().find((entry) => entry.endpoint_id === peerId);
      if (!peer) {
        throw new Error("peer is no longer available");
      }
      await store.refetchLibraries();
      store.setSelectedLibraryId(`peer:${peerId}`);
      await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
    });
  }

  async function handleRemoveLibrary() {
    const library = selectedLibrary();
    if (!library?.removable) return;
    await withSubmitting(async () => {
      if (isPeerLibrary(library)) {
        await removeMediaLibrary(library.id);
        await removePeerLibrary(peerLibraryPeerId(library));
        await store.refetchLibraries();
        await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
        return;
      }
      await removeMediaLibrary(library.id);
      await store.refetchLibraries();
    });
  }

  function syncSelectedLibraryIfNeeded() {
    const library = selectedLibrary();
    if (!library || library.mode !== "sync" || syncProgress()) {
      return;
    }
    void syncLibrary(library.id).catch((err) => {
      store.setError(toErrorMessage(err));
    });
  }

  async function handleRefreshLibrary() {
    const library = selectedLibrary();
    if (!library || isPeerLibrary(library) || isCameraLibrary(library)) {
      syncSelectedLibraryIfNeeded();
      return;
    }
    await withSubmitting(async () => {
      await refreshLibraryIndex(library.id);
      await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
      syncSelectedLibraryIfNeeded();
    });
  }

  function handleSetLibraryMode(
    libraryId: string,
    mode: "browse" | "sync",
    targetId?: string | null,
  ) {
    return setLibraryMode(libraryId, mode, targetId)
      .then(() => store.refetchLibraries())
      .catch((err) => {
        store.setError(toErrorMessage(err));
        throw err;
      });
  }

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

  const getLibraryDropCursorStyle = (): JSX.CSSProperties => {
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

  return (
    <div class="relative flex w-full flex-wrap items-center gap-3">
      <div ref={libraryTabsRef} class="relative gap-2 flex flex-1 overflow-x-auto">
        <div
          aria-hidden="true"
          class="pointer-events-none absolute z-10 w-[3px] rounded-full bg-blue-400 shadow-[0_0_0_3px_rgba(96,165,250,0.18)]"
          style={getLibraryDropCursorStyle()}
        />
        <For each={orderedLibraryEntries()}>
          {(library, libraryIdx) => {
            const offline = () => isLibraryOffline(library, onlinePeerIds());
            const refreshing = () => isLocalLibraryRefreshing(library);
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
                  store.setSelectedLibraryId(library.id);
                }}
                onPointerDown={(event) => startLibraryDrag(event, libraryIdx())}
                onPointerMove={pinned ? undefined : handleLibraryPointerMove}
                onPointerUp={pinned ? undefined : handleLibraryPointerUp}
                onPointerCancel={pinned ? undefined : handleLibraryPointerCancel}
                class={`inline-flex h-7 shrink-0 items-center rounded-full border px-4 text-[12px] font-semibold tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] ${
                  store.selectedLibraryId() === library.id
                    ? offline()
                      ? "border-dashed border-amber-400/45 bg-[var(--surface-active)] text-[var(--text)]"
                      : "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text)]"
                    : offline()
                      ? "border-dashed border-amber-500/25 bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-amber-400/40 hover:text-[var(--text)]"
                      : "border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-medium)] hover:text-[var(--text)]"
                }`}
              >
                <span class="flex items-center gap-2">
                  {(isPeerLibrary(library) ||
                    isCameraLibrary(library) ||
                    isS3Library(library) ||
                    refreshing() ||
                    offline()) && (
                    <span
                      class={`h-1.5 w-1.5 rounded-full ${
                        refreshing()
                          ? "animate-pulse bg-sky-400"
                          : offline()
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                      }`}
                    />
                  )}
                  <span class="block max-w-[140px] overflow-hidden text-ellipsis">
                    {library.name}
                  </span>
                </span>
              </Button>
            );
          }}
        </For>
        <For each={suggestedPeers()}>
          {(peer) => (
            <Button
              type="button"
              class="inline-flex h-7 shrink-0 items-center rounded-full border px-4 text-[12px] font-semibold tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] w-auto border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)] touch-mobile:w-full"
              disabled={store.isSubmitting()}
              onClick={() => void handleAddPeerLibrary(peer.endpoint_id)}
            >
              <span class="block max-w-[140px] overflow-hidden text-ellipsis">
                {peer.name}
              </span>
            </Button>
          )}
        </For>
        <div
          class="relative flex shrink-0 items-center touch-mobile:hidden"
          ref={addDropdownRef}
        >
          <Button
            type="button"
            class="inline-flex h-7 shrink-0 items-center rounded-full border px-4 text-[12px] font-semibold tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] w-auto border-dashed border-[var(--border-dashed)] bg-[var(--surface-subtle)] px-3 text-[14px] leading-none text-[var(--text-muted)] hover:border-[var(--border-active)] hover:text-[var(--text)] touch-mobile:w-full"
            disabled={store.isSubmitting()}
            onContextMenu={(event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setAddDropdownPosition({ left: rect.left, top: rect.bottom });
              setShowAddDropdown((current) => !current);
            }}
            onClick={() => void handleAddLibrary()}
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
              top: `${(addDropdownPosition()?.top ?? 0) + 8}px`,
            }}
          >
            <Button
              type="button"
              role="menuitem"
              class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
              disabled={store.isSubmitting()}
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
                class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                disabled={store.isSubmitting()}
                onClick={() => {
                  setShowAddDropdown(false);
                  openAddS3Form();
                }}
              >
                S3
              </Button>
            </Show>
          </div>
        </Portal>
      </Show>
      <div class="relative flex items-center gap-2" ref={libraryActionsRef}>
        <Show when={selectedLibrary()}>
          <label class="block w-full w-56 touch-mobile:hidden">
            <input
              type="text"
              value={store.filenameFilter()}
              onInput={(event) => store.setFilenameFilter(event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
              placeholder="Search names or tags"
              aria-label="Search names or tags"
            />
          </label>
          <div class="flex items-center gap-0.5 touch-mobile:hidden">
            <Button
              type="button"
              class="h-8 rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40 min-w-7 px-1.5 text-[13px] leading-none"
              disabled={pictureGridZoomIndex() === 0}
              onClick={zoomPictureGridOut}
              aria-label="Decrease thumbnail size"
            >
              -
            </Button>
            <Button
              type="button"
              class="h-8 rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40 min-w-7 px-1.5 text-[13px] leading-none"
              disabled={pictureGridZoomIndex() === PICTURE_GRID_ZOOM_LEVELS.length - 1}
              onClick={zoomPictureGridIn}
              aria-label="Increase thumbnail size"
            >
              +
            </Button>
          </div>
        </Show>

        <Button
          type="button"
          class="h-8 rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40 min-w-8 px-2 text-[14px] leading-none"
          disabled={store.isSubmitting() || !selectedLibrary()}
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
              class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
              disabled={!canRefreshSelectedLibrary() || store.isSubmitting()}
              onClick={() => {
                setShowLibraryActions(false);
                void handleRefreshLibrary();
              }}
            >
              Refresh
            </Button>
            <Show when={selectedLibrary()?.mode === "sync"}>
              <Button
                type="button"
                role="menuitem"
                class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                disabled={store.isSubmitting()}
                onClick={() => {
                  const library = selectedLibrary();
                  if (!library) return;
                  setShowLibraryActions(false);
                  void handleSetLibraryMode(library.id, "browse", null).catch(
                    () => undefined,
                  );
                }}
              >
                Disable Sync
              </Button>
            </Show>
            <Show
              when={
                selectedLibrary()?.mode !== "sync" &&
                (selectedLibrary()?.kind === "s3" || selectedLibrary()?.kind === "peer")
              }
            >
              <Button
                type="button"
                role="menuitem"
                class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                disabled={store.isSubmitting()}
                onClick={() => {
                  const library = selectedLibrary();
                  if (!library) return;
                  setShowLibraryActions(false);
                  void handleSetLibraryMode(library.id, "sync")
                    .then(() => syncLibrary(library.id))
                    .catch(() => undefined);
                }}
              >
                Enable Sync
              </Button>
            </Show>
            <Show
              when={
                selectedLibrary()?.mode !== "sync" &&
                selectedLibrary()?.kind === "directory" &&
                syncTargets().length > 0
              }
            >
              <div class="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-subtle)]">
                Sync to
              </div>
              <For each={syncTargets()}>
                {(target) => (
                  <Button
                    type="button"
                    role="menuitem"
                    class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                    disabled={store.isSubmitting()}
                    onClick={() => {
                      const library = selectedLibrary();
                      if (!library) return;
                      setShowLibraryActions(false);
                      void handleSetLibraryMode(library.id, "sync", target.id)
                        .then(() => syncLibrary(library.id))
                        .catch(() => undefined);
                    }}
                  >
                    {target.name}
                  </Button>
                )}
              </For>
            </Show>
            <Show when={supportsS3Libraries() && isS3Library(selectedLibrary())}>
              <Button
                type="button"
                role="menuitem"
                class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                disabled={store.isSubmitting()}
                onClick={() => {
                  setShowLibraryActions(false);
                  void openEditS3Form();
                }}
              >
                Edit S3
              </Button>
            </Show>
            <Button
              type="button"
              role="menuitem"
              class="flex h-8 w-full items-center rounded-md px-3 text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--danger-text)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--danger-hover-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger-hover-border)] disabled:opacity-40"
              disabled={!selectedLibrary()?.removable || store.isSubmitting()}
              onClick={() => {
                setShowLibraryActions(false);
                void handleRemoveLibrary();
              }}
            >
              Remove Collection
            </Button>
          </div>
        </Show>
      </div>

      <Show when={showS3Form()}>
        <div class="absolute left-1/4 top-full z-10 mt-2 grid grid-cols-3 gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--panel-bg)] p-3 touch-mobile:grid-cols-1">
          <div class="col-span-3 touch-mobile:col-span-1">
            <div class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              {editingS3LibraryId() ? "Edit S3 Library" : "S3 Library"}
            </div>
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Name
            </span>
            <input
              type="text"
              value={(s3Draft().name as string | undefined) ?? ""}
              onInput={(event) => updateS3Draft("name", event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            />
          </label>
          <label class="col-span-2 flex flex-col gap-1 touch-mobile:col-span-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Endpoint
            </span>
            <input
              type="text"
              value={s3Draft().endpoint}
              onInput={(event) => updateS3Draft("endpoint", event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
              placeholder="https://s3.example.com"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Bucket
            </span>
            <input
              type="text"
              value={s3Draft().bucket}
              onInput={(event) => updateS3Draft("bucket", event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Region
            </span>
            <input
              type="text"
              value={s3Draft().region}
              onInput={(event) => updateS3Draft("region", event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Prefix
            </span>
            <input
              type="text"
              value={(s3Draft().prefix as string | undefined) ?? ""}
              onInput={(event) => updateS3Draft("prefix", event.currentTarget.value)}
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
              placeholder="optional/path"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Access Key ID
            </span>
            <input
              type="text"
              value={s3Draft().access_key_id}
              onInput={(event) =>
                updateS3Draft("access_key_id", event.currentTarget.value)
              }
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            />
          </label>
          <label class="col-span-2 flex flex-col gap-1 touch-mobile:col-span-1">
            <span class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
              Secret Access Key
            </span>
            <input
              type="password"
              value={s3Draft().secret_access_key}
              onInput={(event) =>
                updateS3Draft("secret_access_key", event.currentTarget.value)
              }
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] touch-mobile:h-10 touch-mobile:rounded-full touch-mobile:px-4 touch-mobile:text-base"
            />
          </label>
          <div class="col-span-3 flex items-end gap-2 touch-mobile:col-span-1">
            <Button
              type="button"
              class="h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
              disabled={store.isSubmitting()}
              onClick={() => void handleSubmitS3Library()}
            >
              {editingS3LibraryId() ? "Save S3 Library" : "Add S3 Library"}
            </Button>
            <Button
              type="button"
              class="h-8 px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-faint)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
              disabled={store.isSubmitting()}
              onClick={closeS3Form}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
};
