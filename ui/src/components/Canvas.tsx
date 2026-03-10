import { Component, onMount } from "solid-js";

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    // Draw placeholder checkerboard
    const size = 16;
    for (let y = 0; y < canvasRef.height; y += size) {
      for (let x = 0; x < canvasRef.width; x += size) {
        ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? "#2a2a2a" : "#222";
        ctx.fillRect(x, y, size, size);
      }
    }
  });

  return (
    <div class="flex-1 relative bg-gray-900 overflow-hidden flex items-center justify-center">
      <canvas
        ref={canvasRef}
        width="800"
        height="600"
        class="border border-gray-700 shadow-lg"
        style="image-rendering: pixelated;"
      />
    </div>
  );
};

export default Canvas;
