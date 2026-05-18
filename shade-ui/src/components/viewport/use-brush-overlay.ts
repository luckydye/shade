import { type Accessor, createEffect, createSignal } from "solid-js";
import { getMaskThumbnail } from "../../data/use-mask-thumbnail";
import { state } from "../../store/editor-store";

const MAX_SIZE = 512;
const OVERLAY_R = 220;
const OVERLAY_G = 30;
const OVERLAY_B = 30;
const OVERLAY_ALPHA = 0.65;

export function useBrushOverlay(active: Accessor<boolean>): {
  stamp: (
    imageX: number,
    imageY: number,
    radius: number,
    softness: number,
    erase: boolean,
  ) => void;
  canvas: Accessor<HTMLCanvasElement | null>;
} {
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement | null>(null);
  let pixels: Uint8Array | null = null;

  const redraw = () => {
    const c = canvas();
    if (!c || !pixels) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const imgData = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < pixels.length; i++) {
      imgData.data[i * 4 + 0] = OVERLAY_R;
      imgData.data[i * 4 + 1] = OVERLAY_G;
      imgData.data[i * 4 + 2] = OVERLAY_B;
      imgData.data[i * 4 + 3] = Math.round(pixels[i] * OVERLAY_ALPHA);
    }
    ctx.putImageData(imgData, 0, 0);
    setCanvas(c);
  };

  const init = async () => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    if (w === 0 || h === 0) return;
    const scale = Math.min(1, MAX_SIZE / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const next = document.createElement("canvas");
    next.width = tw;
    next.height = th;
    pixels = new Uint8Array(tw * th);
    setCanvas(next);

    const layerIdx = state.selectedLayerIdx;
    if (state.layers[layerIdx]?.has_mask) {
      try {
        const thumb = await getMaskThumbnail(layerIdx, MAX_SIZE, MAX_SIZE);
        pixels = new Uint8Array(thumb.pixels);
        redraw();
      } catch {
        // mask has no data yet
      }
    }
  };

  createEffect(() => {
    if (!active()) {
      pixels = null;
      setCanvas(null);
      return;
    }
    void init();
  });

  const stamp = (
    imageX: number,
    imageY: number,
    radius: number,
    softness: number,
    erase: boolean,
  ) => {
    const c = canvas();
    if (!c || !pixels) return;
    const tw = c.width;
    const th = c.height;
    const scaleX = tw / state.canvasWidth;
    const scaleY = th / state.canvasHeight;
    const tx = imageX * scaleX;
    const ty = imageY * scaleY;
    const tr = radius * scaleX;
    const rCeil = Math.ceil(tr);
    const hardEdge = 1 - softness;
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const px = Math.round(tx) + dx;
        const py = Math.round(ty) + dy;
        if (px < 0 || px >= tw || py < 0 || py >= th) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const t = Math.min(1, dist / (tr + 0.001));
        const alpha =
          t <= hardEdge
            ? 1
            : 0.5 * (1 + Math.cos((Math.PI * (t - hardEdge)) / (1 - hardEdge + 0.001)));
        const idx = py * tw + px;
        if (erase) {
          const floor = Math.round((1 - alpha) * 255);
          pixels[idx] = Math.min(pixels[idx], floor);
        } else {
          pixels[idx] = Math.max(pixels[idx], Math.round(alpha * 255));
        }
      }
    }
    redraw();
  };

  return { stamp, canvas };
}
