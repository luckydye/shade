import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

// Holds the current image as an ImageBitmap so Canvas can draw it immediately
// without a round-trip to the backend.
const [sourceBitmap, setSourceBitmap] = createSignal<ImageBitmap | null>(null);
export { sourceBitmap };
const [previewBitmap, setPreviewBitmap] = createSignal<ImageBitmap | null>(null);
export { previewBitmap };
const [previewFrame, setPreviewFrame] = createSignal<ImageData | null>(null);
export { previewFrame };

function replaceBitmap(
  setter: (bitmap: ImageBitmap | null) => void,
  current: () => ImageBitmap | null,
  next: ImageBitmap | null,
) {
  current()?.close();
  setter(next);
}

export interface LayerInfo {
  kind: "image" | "adjustment";
  visible: boolean;
  opacity: number;
  blend_mode?: string;
  adjustments?: bridge.AdjustmentValues | null;
}

export interface EditorState {
  layers: LayerInfo[];
  canvasWidth: number;
  canvasHeight: number;
  selectedLayerIdx: number;
  isLoading: boolean;
  webgpuAvailable: boolean;
}

const [state, setState] = createStore<EditorState>({
  layers: [],
  canvasWidth: 0,
  canvasHeight: 0,
  selectedLayerIdx: -1,
  isLoading: false,
  webgpuAvailable: true,
});

export { state };

function resolveSelectedLayerIdx(layers: LayerInfo[], currentIdx: number) {
  if (currentIdx >= 0 && currentIdx < layers.length) {
    return currentIdx;
  }
  for (let idx = layers.length - 1; idx >= 0; idx -= 1) {
    if (layers[idx].kind === "adjustment") {
      return idx;
    }
  }
  return layers.length - 1;
}

export async function openImage(path: string) {
  setState("isLoading", true);
  replaceBitmap(setSourceBitmap, sourceBitmap, null);
  replaceBitmap(setPreviewBitmap, previewBitmap, null);
  setPreviewFrame(null);
  try {
    const info = await bridge.openImage(path);
    setState({ canvasWidth: info.canvas_width, canvasHeight: info.canvas_height });
    await refreshLayerStack();
    await refreshPreview();
  } finally {
    setState("isLoading", false);
  }
}

export async function openImageFile(file: File) {
  // Decode for immediate canvas preview — no backend round-trip needed.
  const bitmap = await createImageBitmap(file);
  replaceBitmap(setSourceBitmap, sourceBitmap, bitmap);
  replaceBitmap(setPreviewBitmap, previewBitmap, null);
  setPreviewFrame(null);

  setState("isLoading", true);
  try {
    const info = await bridge.openImageFile(file);
    setState({ canvasWidth: info.canvas_width, canvasHeight: info.canvas_height });
    await refreshLayerStack();
    await refreshPreview();
  } finally {
    setState("isLoading", false);
  }
}

export async function refreshLayerStack() {
  const info = await bridge.getLayerStack();
  const layers = info.layers as LayerInfo[];
  setState({
    layers,
    canvasWidth: info.canvas_width,
    canvasHeight: info.canvas_height,
    selectedLayerIdx: layers.length === 0
      ? -1
      : resolveSelectedLayerIdx(layers, state.selectedLayerIdx),
  });
}

export async function setLayerVisible(idx: number, visible: boolean) {
  await bridge.setLayerVisible(idx, visible);
  await refreshLayerStack();
  await refreshPreview();
}

export async function setLayerOpacity(idx: number, opacity: number) {
  await bridge.setLayerOpacity(idx, opacity);
  await refreshLayerStack();
  await refreshPreview();
}

export async function applyEdit(params: Record<string, unknown>) {
  await bridge.applyEdit(params);
  await refreshLayerStack();
  await refreshPreview();
}

export function selectLayer(idx: number) {
  setState("selectedLayerIdx", idx);
}

export async function addLayer(kind: string) {
  const idx = await bridge.addLayer(kind);
  await refreshLayerStack();
  setState("selectedLayerIdx", idx);
  await refreshPreview();
}

export async function refreshPreview() {
  try {
    const frame = await bridge.renderPreview();
    if (frame.kind === "rgba") {
      if (frame.width === 0 || frame.height === 0) return;
      replaceBitmap(setPreviewBitmap, previewBitmap, null);
      const pixels = new Uint8ClampedArray(frame.pixels.length);
      pixels.set(frame.pixels);
      setPreviewFrame(new ImageData(pixels, frame.width, frame.height));
      return;
    }
    if (!frame.dataUrl) return;
    setPreviewFrame(null);
    const response = await fetch(frame.dataUrl);
    const bitmap = await createImageBitmap(await response.blob());
    replaceBitmap(setPreviewBitmap, previewBitmap, bitmap);
  } catch (error) {
    console.warn("Failed to refresh preview", error);
  }
}
