import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  isDrawerOpen,
  openImageFile,
  panPreview,
  previewContextFrame,
  previewFrame,
  resetPreviewViewport,
  setPreviewViewportSize,
  state,
  zoomPreviewDelta,
} from "../store/editor";

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  let scratchCanvas: HTMLCanvasElement | undefined;
  let contextCanvas: HTMLCanvasElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  let panStart: { x: number; y: number } | null = null;

  function drawFrame() {
    if (!canvasRef || !stageRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    const cssWidth = Math.max(1, Math.floor(stageRef.clientWidth));
    const cssHeight = Math.max(1, Math.floor(stageRef.clientHeight));
    const devicePixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio));
    if (canvasRef.width !== pixelWidth || canvasRef.height !== pixelHeight) {
      canvasRef.width = pixelWidth;
      canvasRef.height = pixelHeight;
    }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const fitScale = Math.min(cssWidth / state.canvasWidth, cssHeight / state.canvasHeight);
    const imageScale = fitScale * state.previewZoom;
    const imageX = cssWidth * 0.5 - state.previewCenterX * imageScale;
    const imageY = cssHeight * 0.5 - state.previewCenterY * imageScale;
    const contextFrame = previewContextFrame();
    if (contextFrame) {
      contextCanvas ??= document.createElement("canvas");
      if (contextCanvas.width !== contextFrame.width || contextCanvas.height !== contextFrame.height) {
        contextCanvas.width = contextFrame.width;
        contextCanvas.height = contextFrame.height;
      }
      const contextScratch = contextCanvas.getContext("2d");
      if (!contextScratch) {
        throw new Error("context canvas 2d context is required");
      }
      contextScratch.putImageData(contextFrame, 0, 0);
      ctx.drawImage(
        contextCanvas,
        imageX,
        imageY,
        state.canvasWidth * imageScale,
        state.canvasHeight * imageScale,
      );
    }
    const frame = previewFrame();
    if (!frame) return;
    scratchCanvas ??= document.createElement("canvas");
    if (scratchCanvas.width !== frame.image.width || scratchCanvas.height !== frame.image.height) {
      scratchCanvas.width = frame.image.width;
      scratchCanvas.height = frame.image.height;
    }
    const scratchContext = scratchCanvas.getContext("2d");
    if (!scratchContext) {
      throw new Error("scratch canvas 2d context is required");
    }
    scratchContext.putImageData(frame.image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      scratchCanvas,
      imageX + frame.crop.x * imageScale,
      imageY + frame.crop.y * imageScale,
      frame.crop.width * imageScale,
      frame.crop.height * imageScale,
    );
  }

  createEffect(() => {
    state.previewViewportWidth;
    state.previewViewportHeight;
    previewContextFrame();
    previewFrame();
    drawFrame();
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
    const deltaModeScale = e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? stageRef?.clientHeight ?? 1
        : 1;
    const delta = e.deltaY * deltaModeScale;
    zoomPreviewDelta(delta, e.ctrlKey);
    drawFrame();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (state.previewZoom <= 1) return;
    panStart = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!panStart) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    panPreview(dx, dy);
    drawFrame();
    panStart = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = () => {
    panStart = null;
  };
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
              width: "100%",
              height: "100%",
            }}
            class={`bg-[#111111] ${
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
