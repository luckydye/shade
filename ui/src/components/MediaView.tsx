import { Component, createResource, For, Suspense } from "solid-js";
import { listPictures } from "../bridge/index";
import { openImage } from "../store/editor";

let _convertFileSrc: ((path: string) => string) | null = null;

async function loadConvertFileSrc() {
  if (!_convertFileSrc) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    _convertFileSrc = convertFileSrc;
  }
  return _convertFileSrc;
}

async function fetchImages() {
  const [paths, convert] = await Promise.all([listPictures(), loadConvertFileSrc()]);
  return paths.map((path) => ({ path, src: convert(path) }));
}

export const MediaView: Component = () => {
  const [images] = createResource(fetchImages);

  return (
    <div class="flex flex-1 flex-col overflow-hidden">
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
              {({ path, src }) => (
                <button
                  type="button"
                  class="group flex flex-col gap-1.5 rounded-xl text-left transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                  onClick={() => void openImage(path)}
                >
                  <div class="aspect-square w-full overflow-hidden rounded-lg bg-white/[0.04]">
                    <img
                      src={src}
                      alt={path.split("/").pop()}
                      class="h-full w-full object-contain transition-opacity group-hover:opacity-90"
                      loading="lazy"
                    />
                  </div>
                  <span class="truncate px-0.5 text-[11px] text-white/40">{path.split("/").pop()}</span>
                </button>
              )}
            </For>
          </div>
        </Suspense>
      </div>
    </div>
  );
};
