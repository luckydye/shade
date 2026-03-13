import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  getPreviewDisplaySize,
  isDrawerOpen,
  openImageFile,
  panPreview,
  previewFrame,
  resetPreviewViewport,
  setPreviewViewportSize,
  state,
  zoomPreview,
} from "../store/editor";

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  let panStart: { x: number; y: number } | null = null;

  createEffect(() => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    const frame = previewFrame();
    if (frame) {
      canvasRef.width = frame.width;
      canvasRef.height = frame.height;
      ctx.putImageData(frame, 0, 0);
      return;
    }

    ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
  });

  onMount(() => {
    const stage = stageRef;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      setPreviewViewportSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(stage);
    onCleanup(() => observer.disconnect());
  });

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      await openImageFile(file);
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomPreview(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (state.previewZoom <= 1) return;
    panStart = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!panStart) return;
    panPreview(e.clientX - panStart.x, e.clientY - panStart.y);
    panStart = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = () => {
    panStart = null;
  };

  const displaySize = () => getPreviewDisplaySize();

  return (
    <section class="relative flex min-h-[42vh] flex-1 overflow-hidden lg:min-h-0">
      <div
        ref={stageRef}
        class="relative flex-1 overflow-hidden bg-[#0b0b0b]"
        style={{ "view-transition-name": "active-media" }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.05),_transparent_45%)]" />

        <div class="relative flex h-full items-center justify-center pb-25 lg:pb-0" style={{ "padding-bottom": isDrawerOpen() ? "33vh" : "" }}>
          <canvas
            ref={canvasRef}
            width="800"
            height="600"
            onDblClick={() => resetPreviewViewport()}
            style={{
              width: `${displaySize().width}px`,
              height: `${displaySize().height}px`,
            }}
            class={`bg-[#111111] object-contain ${
              state.layers.length === 0 ? "opacity-0" : "opacity-100"
            }`}
          />
          {state.layers.length === 0 && (
            <div class="pointer-events-none absolute flex max-w-sm flex-col items-center gap-3 rounded-[26px] border border-white/8 bg-black/40 px-8 py-10 text-center backdrop-blur-sm">
              <div class="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/6 text-white/80">
                <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-6 w-6">
                  <path d="M12 16V6" />
                  <path d="m7.5 10.5 4.5-4.5 4.5 4.5" />
                  <path d="M4 18.5h16" />
                </svg>
              </div>
              <div>
                <div class="text-lg font-semibold tracking-[-0.02em] text-white">Drop an image to start</div>
                <div class="mt-1 text-sm text-white/48">
                  Drag a photo into the stage or use the Open action in the top bar.
                </div>
              </div>
            </div>
          )}
        </div>

        {dragging() && (
          <div class="absolute inset-4 flex items-center justify-center rounded-[24px] border border-dashed border-white/35 bg-black/55 backdrop-blur-sm">
            <span class="rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-white">
              Release to open image
            </span>
          </div>
        )}
      </div>
    </section>
  );
};

export default Canvas;
