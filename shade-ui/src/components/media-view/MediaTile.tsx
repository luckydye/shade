import type { Component } from "solid-js";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  resetCameraThumbnailFailure,
  resetLocalThumbnailFailure,
} from "../../bridge/index";
import { Button } from "../Button";
import { MediaRating } from "../MediaRating";
import { loadItemSrc, type MediaItem } from "./media-utils";

type MediaTileProps = {
  item: MediaItem;
  cachedSrc?: string;
  compact?: boolean;
  active?: boolean;
  selected?: boolean;
  showSelectionControls?: boolean;
  offline?: boolean;
  disableThumbnailLoad?: boolean;
  onActivate: (src: string | null) => void;
  onThumbnailLoaded?: (src: string) => void;
  onToggleSelection: () => void;
};

export const MediaTile: Component<MediaTileProps> = (props) => {
  const [isIntersecting, setIsIntersecting] = createSignal(false);
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loadRequestVersion, setLoadRequestVersion] = createSignal(0);
  let containerRef: HTMLDivElement | undefined;
  let isLoadingSrc = false;

  const loadErrorSummary = () => {
    const error = loadError();
    if (!error) {
      return null;
    }
    const normalized = error.replace(/\s+/g, " ").trim();
    return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
  };

  onMount(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    if (containerRef) {
      observer.observe(containerRef);
    }
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const cachedSrc = props.cachedSrc;
    if (!cachedSrc || src() === cachedSrc) {
      return;
    }
    setLoadError(null);
    setSrc(cachedSrc);
  });

  createEffect(() => {
    loadRequestVersion();
    if (
      props.disableThumbnailLoad ||
      !isIntersecting() ||
      props.cachedSrc ||
      src() ||
      isLoadingSrc
    ) {
      return;
    }
    const controller = new AbortController();
    setLoadError(null);
    isLoadingSrc = true;
    void loadItemSrc(props.item, controller.signal)
      .then((nextSrc) => {
        setSrc(nextSrc);
        props.onThumbnailLoaded?.(nextSrc);
      })
      .catch((error) => {
        if (controller.signal.aborted || props.offline) {
          return;
        }
        console.error("thumbnail load failed", props.item, error);
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        isLoadingSrc = false;
      });
    onCleanup(() => {
      controller.abort();
      isLoadingSrc = false;
    });
  });
  function handleClick(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
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
      setLoadError(null);
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
        title={loadError() ?? undefined}
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
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
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
              src={src()}
              alt={props.item.name}
              class="h-full w-full object-contain transition-opacity group-hover:opacity-90"
              loading="lazy"
            />
          )}
          {loadError() && (
            <div class="absolute inset-0 flex flex-col items-center justify-end rounded-lg bg-gradient-to-t from-black/90 via-black/70 to-transparent px-2 pb-2 text-center">
              <span class="text-[11px] font-medium text-red-400">Thumbnail failed</span>
              <span class="mt-1 line-clamp-3 text-[10px] leading-4 text-red-200/90">
                {loadErrorSummary()}
              </span>
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
