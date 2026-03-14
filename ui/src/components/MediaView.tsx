import { Component, createEffect, createResource, createSignal, For, onCleanup, onMount, Suspense } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { addMediaLibrary, listLibraryImages, listMediaLibraries, removeMediaLibrary } from "../bridge/index";
import { resolveMediaSrc } from "../media-source";
import { openImage, state } from "../store/editor";

const ImageTile: Component<{ path: string }> = (props) => {
  const [isIntersecting, setIsIntersecting] = createSignal(false);
  const [src, setSrc] = createSignal<string | undefined>(undefined);
  // PHAsset local identifiers (iOS) don't have a meaningful filename component.
  const name = () => props.path.startsWith("/") ? (props.path.split("/").pop() ?? "") : null;
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
    void resolveMediaSrc(props.path, controller.signal)
      .then((nextSrc) => setSrc(nextSrc))
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        void error;
        setLoadError(true);
        errorTimer = setTimeout(() => setLoadError(false), 4000);
      });
    onCleanup(() => controller.abort());
  });

  // Revoke blob URLs created for non-native formats.
  onCleanup(() => {
    const url = src();
    if (url?.startsWith("blob:") && url !== state.loadingMediaSrc) URL.revokeObjectURL(url);
    clearTimeout(errorTimer);
  });

  function handleClick() {
    setLoadError(false);
    if (imgRef) imgRef.style.viewTransitionName = "active-media";

    const handleError = () => {
      setLoadError(true);
      errorTimer = setTimeout(() => setLoadError(false), 4000);
    };

    // void the promise so startViewTransition captures the "after" state immediately
    // (isLoading=true fires synchronously inside openImage), while still handling errors.
    if (document.startViewTransition) {
      document.startViewTransition(() => void openImage(props.path, src() ?? null).catch(handleError));
    } else {
      void openImage(props.path, src() ?? null).catch(handleError);
    }
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
            alt={name()}
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
      {name() && <span class="truncate px-0.5 text-[11px] text-white/40">{name()}</span>}
    </button>
  );
};

export const MediaView: Component = () => {
  const [libraries, { refetch: refetchLibraries }] = createResource(listMediaLibraries);
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const [images, { refetch: refetchImages }] = createResource(selectedLibraryId, listLibraryImages);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const availableLibraries = libraries();
    if (!availableLibraries?.length) {
      setSelectedLibraryId(null);
      return;
    }
    const current = selectedLibraryId();
    if (current && availableLibraries.some((library) => library.id === current)) return;
    setSelectedLibraryId(availableLibraries[0].id);
  });

  const selectedLibrary = () => libraries()?.find((library) => library.id === selectedLibraryId()) ?? null;

  async function handleAddLibrary() {
    if (isSubmitting()) return;
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
      await refetchImages();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRemoveLibrary() {
    const library = selectedLibrary();
    if (!library?.removable) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await removeMediaLibrary(library.id);
      await refetchLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div class="flex flex-1 flex-col overflow-hidden mt-[calc(env(safe-area-inset-top)+3.5rem)] md:mt-0">
      <div class="border-b border-white/6 px-6 py-4">
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-8">
            <h1 class="hidden md:block text-sm font-medium text-white/80">Libraries</h1>
            <div class="flex flex-1 gap-2 overflow-x-auto">
              <For each={libraries()}>
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
          {error() && (
            <p class="text-sm text-red-300">{error()}</p>
          )}
          {selectedLibrary()?.path && (
            <p class="truncate text-xs text-white/28">{selectedLibrary()!.path}</p>
          )}
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-6">
        <Suspense fallback={<p class="text-sm text-white/30">Loading…</p>}>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            <For
              each={images()}
              fallback={<p class="col-span-full text-sm text-white/30">No images found in {selectedLibrary()?.name ?? "this library"}.</p>}
            >
              {(path) => <ImageTile path={path} />}
            </For>
          </div>
        </Suspense>
      </div>
    </div>
  );
};
