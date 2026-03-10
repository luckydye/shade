import { Component, createEffect, createSignal } from "solid-js";
import { openImageFile, previewBitmap, sourceBitmap, state } from "../store/editor";

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [dragging, setDragging] = createSignal(false);

  // Redraw whenever a new source image arrives.
  createEffect(() => {
    const bitmap = previewBitmap() ?? sourceBitmap();
    if (!bitmap || !canvasRef) return;

    canvasRef.width = bitmap.width;
    canvasRef.height = bitmap.height;

    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0);
  });

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    // Only clear when leaving the drop zone itself, not a child
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

  return (
    <div
      class="flex-1 relative bg-gray-900 overflow-hidden flex items-center justify-center"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        width="800"
        height="600"
        class="max-w-full max-h-full border border-gray-700 shadow-lg object-contain"
      />

      {/* Drop overlay */}
      {dragging() && (
        <div class="absolute inset-0 flex items-center justify-center bg-blue-900/40 border-2 border-dashed border-accent pointer-events-none">
          <span class="text-accent text-sm font-medium">Drop image to open</span>
        </div>
      )}

      {/* Empty state hint */}
      {!dragging() && state.layers.length === 0 && (
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span class="text-gray-600 text-sm">Open an image or drag and drop here</span>
        </div>
      )}
    </div>
  );
};

export default Canvas;
