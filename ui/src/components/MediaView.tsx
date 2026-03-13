import { Component, createResource, createSignal, For, onCleanup, Suspense } from "solid-js";
import { getThumbnail, listPictures } from "../bridge/index";
import { openImage } from "../store/editor";

// Formats the browser can display directly via the asset protocol.
const NATIVE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

function ext(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

let _convertFileSrc: ((path: string) => string) | null = null;

async function getConvertFileSrc() {
  if (!_convertFileSrc) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    _convertFileSrc = convertFileSrc;
  }
  return _convertFileSrc;
}

async function resolveSrc(path: string): Promise<string> {
  if (NATIVE_EXTENSIONS.has(ext(path))) {
    const convert = await getConvertFileSrc();
    return convert(path);
  }
  return getThumbnail(path);
}

const ImageTile: Component<{ path: string }> = (props) => {
  const [src] = createResource(() => props.path, resolveSrc);
  // PHAsset local identifiers (iOS) don't have a meaningful filename component.
  const name = () => props.path.startsWith("/") ? (props.path.split("/").pop() ?? "") : null;
  const [loadError, setLoadError] = createSignal(false);
  let imgRef: HTMLImageElement | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  // Revoke blob URLs created for non-native formats.
  onCleanup(() => {
    const url = src();
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
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
      document.startViewTransition(() => void openImage(props.path).catch(handleError));
    } else {
      void openImage(props.path).catch(handleError);
    }
  }

  return (
    <button
      type="button"
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
  const [images] = createResource(listPictures);

  return (
    <div class="flex flex-1 flex-col overflow-hidden mt-[calc(env(safe-area-inset-top)+3.5rem)]">
      <div class="border-b border-white/6 px-6 py-4">
        <h1 class="text-sm font-medium text-white/80">Pictures</h1>
      </div>
      <div class="flex-1 overflow-y-auto p-6">
        <Suspense fallback={<p class="text-sm text-white/30">Loading…</p>}>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            <For
              each={images()}
              fallback={<p class="col-span-full text-sm text-white/30">No images found in Pictures.</p>}
            >
              {(path) => <ImageTile path={path} />}
            </For>
          </div>
        </Suspense>
      </div>
    </div>
  );
};
