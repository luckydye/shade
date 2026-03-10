import { Component, createSignal, onMount } from "solid-js";
import { openImageFile, state } from "../store/editor";

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [dragging, setDragging] = createSignal(false);

  onMount(() => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    const size = 16;
    for (let y = 0; y < canvasRef.height; y += size) {
      for (let x = 0; x < canvasRef.width; x += size) {
        ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? "#2a2a2a" : "#222";
        ctx.fillRect(x, y, size, size);
      }
    }
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
        class="border border-gray-700 shadow-lg"
        style="image-rendering: pixelated;"
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
