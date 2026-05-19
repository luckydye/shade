import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { MediaItem } from "../../data/use-library-items";
import { Button } from "../Button";
import { actions } from "../../store/actions";
import { mediaViewFocusedItemId } from "../../store/media-view-context";
import { MediaTile } from "./MediaTile";
import { useMediaViewStore } from "./media-view-store";
import {
  formatModificationMonth,
  mediaItemKey,
  type MediaGridRow,
  modificationMonthKey,
} from "./media-utils";
import { setPictureGridColumns, setPictureGridRows } from "./picture-grid-state";

const GRID_GAP = 12;
const TILE_LABEL_HEIGHT = 24;
const HEADER_ROW_HEIGHT = 32;
const OVERSCAN_ROWS = 2;

export type PictureGridProps = {
  displayedItemCount: number;
  displayedItems: MediaItem[];
  hasLibraries: boolean;
  isEditorStrip: boolean;
  isLibraryScanComplete: boolean;
  availableItemCount: number;
  selectedLibraryIsOffline: boolean;
  itemsLoading: boolean;
  activeFilenameFilterCount: number;
  filenameFilter: string;
  zoomIndex: number;
  zoomLevels: readonly number[];
  itemById: (id: string) => MediaItem | undefined;
  getBufferedThumbnailSrc: (item: MediaItem) => string | undefined;
  shouldDeferEditorStripThumbnails: boolean;
  activeMediaItemId: string | null;
  isSelected: (id: string) => boolean;
  isFocused: (id: string) => boolean;
  showSelectionControls: boolean;
  onThumbnailLoaded: (item: MediaItem, src: string) => void;
  onActivate: (item: MediaItem, src: string | null) => void;
  onToggleSelection: (id: string) => void;
  onShiftSelect: (id: string) => void;
  onFocusItem: (id: string) => void;
};

export const PictureGrid: Component<PictureGridProps> = (props) => {
  const store = useMediaViewStore();
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [viewportWidth, setViewportWidth] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null);
  const [anchorRowOffset, setAnchorRowOffset] = createSignal(0);
  const [isScrolling, setIsScrolling] = createSignal(false);
  const [scrollRef, setScrollRef] = createSignal<HTMLDivElement | null>(null);
  let scrollLabelTimeout: ReturnType<typeof setTimeout> | undefined;

  const tileMinWidth = createMemo(() => {
    const base = props.zoomLevels[props.zoomIndex] ?? 160;
    if (viewportWidth() < 640) {
      return Math.min(base, 140);
    }
    return base;
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
    for (const item of props.displayedItems) {
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

  createEffect(
    on(columns, (_cols, prevCols) => {
      if (prevCols === undefined) return;
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
          const element = scrollRef();
          if (!element) return;
          element.scrollTop = newTop;
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
  const containerHeight = createMemo(() =>
    stableGridRows().length === 0 ? 0 : totalHeight(),
  );

  const scrollLabel = createMemo(() => {
    const id = anchorItemId();
    if (!id) return "";
    const item = props.itemById(id);
    if (!item) return "";
    return formatModificationMonth(item.modifiedAt);
  });

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

  const handleAddLibrary = async () => {
    if (store.isSubmitting()) return;
    store.setIsSubmitting(true);
    store.setError(null);
    try {
      const selectedPath = await store.pickDirectory();
      if (selectedPath === null) return;
      const library = await store.addMediaLibrary(selectedPath);
      await store.refetchLibraries();
      store.setSelectedLibraryId(library.id);
      await Promise.all([store.refetchCachedLibraryItems(), store.refetchItems()]);
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err));
    } finally {
      store.setIsSubmitting(false);
    }
  };

  createEffect(() => {
    const element = scrollRef();
    if (!(element instanceof HTMLDivElement)) {
      return;
    }
    const updateViewport = () => {
      setViewportHeight(element.clientHeight);
      setViewportWidth(element.clientWidth - 48);
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    onCleanup(() => {
      observer.disconnect();
    });
  });

  const resetScrollPosition = () => {
    setScrollTop(0);
    setAnchorItemId(null);
    setAnchorRowOffset(0);
    const element = scrollRef();
    if (element) {
      element.scrollTop = 0;
    }
  };

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const top = event.currentTarget.scrollTop;
    setScrollTop(top);
    updateScrollAnchor(top);
    setIsScrolling(true);
    clearTimeout(scrollLabelTimeout);
    scrollLabelTimeout = setTimeout(() => setIsScrolling(false), 1000);
  };

  const scrollFocusedItemIntoView = (id: string | null, keyboardNavActive: boolean) => {
    if (!id || !keyboardNavActive) return;
    const rows = stableGridRows();
    const offsets = rowOffsets();
    const rowHeight = tileRowHeight();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind !== "items" || !row.ids.includes(id)) continue;
      const rowTop = offsets[i];
      const rowBottom = rowTop + rowHeight;
      const container = scrollRef();
      if (!container) return;
      const viewTop = scrollTop();
      const viewBottom = viewTop + viewportHeight();
      if (rowTop < viewTop) {
        container.scrollTop = rowTop - 4;
        setScrollTop(rowTop - 4);
      } else if (rowBottom > viewBottom) {
        const newTop = rowBottom - viewportHeight() + 4;
        container.scrollTop = newTop;
        setScrollTop(newTop);
      }
      break;
    }
  };

  createEffect(() => {
    setPictureGridColumns(columns());
  });

  createEffect(() => {
    setPictureGridRows(stableGridRows());
  });

  actions.register({
    id: "media.grid.reset-scroll",
    title: "Reset Media Grid Scroll",
    group: "Media",
    when: (ctx) => ctx.currentView === "media" || ctx.currentView === "editor",
    run: resetScrollPosition,
  });

  actions.register({
    id: "media.grid.scroll-focused-into-view",
    title: "Scroll Focused Image Into View",
    group: "Media",
    when: (ctx) => ctx.mediaViewFocusedItemId !== null,
    run: () => scrollFocusedItemIntoView(mediaViewFocusedItemId(), true),
  });

  onCleanup(() => {
    clearTimeout(scrollLabelTimeout);
    setPictureGridColumns(1);
    setPictureGridRows([]);
    actions.unregister("media.grid.reset-scroll");
    actions.unregister("media.grid.scroll-focused-into-view");
  });

  const renderRows = (compact: boolean) => (
    <div
      style={{
        height: `${containerHeight()}px`,
        position: "relative",
      }}
    >
      <div
        class={compact ? "grid gap-x-0 gap-y-1" : "grid gap-1"}
        style={{
          "grid-template-columns": gridTemplateColumns(),
          transform: `translateY(${offsetY()}px)`,
        }}
      >
        <For each={visibleRows()}>
          {(row) =>
            row.kind === "date" ? (
              <h2
                class={
                  compact
                    ? "col-span-full px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)] first:pt-0"
                    : "px-1 col-span-full py-3 text-xs font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)] first:pt-0"
                }
              >
                {formatModificationMonth(row.modifiedAt)}
              </h2>
            ) : (
              <For each={row.ids}>
                {(id) => {
                  const item = () => props.itemById(id);
                  return (
                    <Show when={item()}>
                      <MediaTile
                        item={item()!}
                        cachedSrc={props.getBufferedThumbnailSrc(item()!)}
                        compact={compact}
                        offline={props.selectedLibraryIsOffline}
                        disableThumbnailLoad={
                          compact ? props.shouldDeferEditorStripThumbnails : undefined
                        }
                        active={props.activeMediaItemId === id}
                        selected={props.isSelected(id)}
                        focused={props.isFocused(id)}
                        showSelectionControls={props.showSelectionControls}
                        onThumbnailLoaded={(src) =>
                          props.onThumbnailLoaded(item()!, src)
                        }
                        onActivate={(src) => props.onActivate(item()!, src)}
                        onToggleSelection={() => props.onToggleSelection(id)}
                        onShiftSelect={() => props.onShiftSelect(id)}
                        onFocus={() => props.onFocusItem(id)}
                      />
                    </Show>
                  );
                }}
              </For>
            )
          }
        </For>
      </div>
    </div>
  );

  return (
    <div
      ref={setScrollRef}
      class={
        props.isEditorStrip
          ? "media-scroll relative flex-1 min-h-0 overflow-y-auto px-2 py-3"
          : "media-scroll relative flex-1 min-h-0 overflow-y-auto p-4 touch-mobile:p-1"
      }
      onScroll={handleScroll}
    >
      <Show
        when={props.displayedItemCount > 0}
        fallback={
          <Show
            when={props.hasLibraries}
            fallback={
              <Show
                when={!props.isEditorStrip}
                fallback={
                  <div class="px-3 py-4 text-sm text-[var(--text-faint)] mx-1 text-xs">
                    Open the media view to add your first library.
                  </div>
                }
              >
                <div class="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-8 text-center">
                  <div class="space-y-1">
                    <p class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-subtle)]">
                      Media Library
                    </p>
                    <h2 class="text-lg font-semibold text-[var(--text)]">
                      Add your first library
                    </h2>
                  </div>
                  <p class="max-w-sm text-sm leading-6 text-[var(--text-dim)]">
                    Pick a folder with your images. Shade will index it and show it here
                    in the media view.
                  </p>
                  <Button
                    type="button"
                    class="h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40"
                    disabled={store.isSubmitting()}
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
              when={props.selectedLibraryIsOffline}
              fallback={
                <Show
                  when={props.itemsLoading || !props.isLibraryScanComplete}
                  fallback={
                    <div
                      class={`px-3 py-4 text-sm text-[var(--text-faint)] ${
                        props.isEditorStrip ? "mx-1 text-xs" : "text-sm"
                      }`}
                    >
                      {props.activeFilenameFilterCount > 0
                        ? `No media match "${props.filenameFilter.trim()}".`
                        : `No images found in ${store.selectedLibrary()?.name ?? "this library"}.`}
                    </div>
                  }
                >
                  <div
                    class={`mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl px-6 py-8 text-center ${
                      props.isEditorStrip ? "mx-1 text-xs" : "text-sm"
                    }`}
                  >
                    <div class="flex h-14 w-14 items-center justify-center rounded-2xl text-[var(--text-muted)]">
                      <div class="relative h-8 w-8 animate-spin rounded-full border-2 border-[var(--border-medium)] border-t-[var(--text-muted)]" />
                    </div>
                    <div class="space-y-1">
                      <h2 class="text-sm font-semibold text-[var(--text)]">
                        {props.availableItemCount > 0
                          ? `Found ${props.availableItemCount.toLocaleString()} images…`
                          : "Scanning library…"}
                      </h2>
                      <p class="max-w-sm text-sm leading-6 text-[var(--text-dim)]">
                        {props.itemsLoading
                          ? "Loading your library."
                          : "Indexing images in this library. This may take a while for large or remote libraries."}
                      </p>
                    </div>
                  </div>
                </Show>
              }
            >
              <div
                class={`mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl px-6 py-8 text-center ${
                  props.isEditorStrip ? "mx-1 text-xs" : "text-sm"
                }`}
              >
                <div class="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border-medium)] bg-[var(--surface)] text-[var(--text-muted)]">
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    class="h-7 w-7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
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
        <>
          <Show when={!props.isEditorStrip} fallback={renderRows(true)}>
            {renderRows(false)}
          </Show>
          <Show when={isScrolling() && scrollLabel()}>
            <div
              class={`pointer-events-none absolute ${
                props.isEditorStrip
                  ? "right-0 translate-x-[calc(100%+0.5rem)] text-left"
                  : "right-4"
              } z-20 -translate-y-1/2 rounded-md bg-[var(--panel-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)] shadow-md ring-1 ring-[var(--border-medium)]`}
              style={{ top: `${tooltipTop()}px` }}
            >
              {scrollLabel()}
            </div>
          </Show>
        </>
      </Show>
    </div>
  );
};
