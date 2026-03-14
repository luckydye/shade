import { Component, createEffect, createResource, createSignal, For, onCleanup, onMount, Suspense } from "solid-js";
import { listLibraryImages, listMediaLibraries } from "../bridge/index";
import { resolveMediaSrc } from "../media-source";
import { openImage, state } from "../store/editor";

const ImageTile: Component<{ path: string }> = (props) => {
  const [visible, setVisible] = createSignal(false);
  const [src] = createResource(() => visible() ? props.path : undefined, resolveMediaSrc);
  // PHAsset local identifiers (iOS) don't have a meaningful filename component.
  const name = () => props.path.startsWith("/") ? (props.path.split("/").pop() ?? "") : null;
  const [loadError, setLoadError] = createSignal(false);
  let containerRef: HTMLButtonElement | undefined;
  let imgRef: HTMLImageElement | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    if (containerRef) observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
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
        <Suspense fallback={<div class="h-full w-full animate-pulse bg-white/[0.06]" />}>
          <img
            ref={imgRef}
            src={src()}
            alt={name()}
            class="h-full w-full object-contain transition-opacity group-hover:opacity-90"
            loading="lazy"
          />
        </Suspense>
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
  const [libraries] = createResource(listMediaLibraries);
  const [selectedLibraryId, setSelectedLibraryId] = createSignal<string | null>(null);
  const [images] = createResource(selectedLibraryId, listLibraryImages);

  createEffect(() => {
    const availableLibraries = libraries();
    if (!availableLibraries?.length) return;
    if (selectedLibraryId()) return;
    setSelectedLibraryId(availableLibraries[0].id);
  });

  const selectedLibrary = () => libraries()?.find((library) => library.id === selectedLibraryId()) ?? null;

  return (
    <div class="flex flex-1 flex-col overflow-hidden mt-[calc(env(safe-area-inset-top)+3.5rem)] md:mt-0">
      <div class="border-b border-white/6 px-6 py-4">
        <div class="flex items-center gap-8">
          <div class="flex items-center justify-between gap-4">
            <h1 class="text-sm font-medium text-white/80">Libraries</h1>
          </div>
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
          </div>
          <div>
            <span class="text-xs font-medium uppercase tracking-[0.12em] text-white/28">
              {selectedLibrary()?.kind ?? "source"}
            </span>
          </div>
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
