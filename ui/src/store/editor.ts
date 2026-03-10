import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

// Holds the current image as an ImageBitmap so Canvas can draw it immediately
// without a round-trip to the backend.
const [sourceBitmap, setSourceBitmap] = createSignal<ImageBitmap | null>(null);
export { sourceBitmap };
const [previewBitmap, setPreviewBitmap] = createSignal<ImageBitmap | null>(null);
export { previewBitmap };

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

export async function openImage(path: string) {
  setState("isLoading", true);
  replaceBitmap(setSourceBitmap, sourceBitmap, null);
  replaceBitmap(setPreviewBitmap, previewBitmap, null);
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
  setState({
    layers: info.layers as LayerInfo[],
    canvasWidth: info.canvas_width,
    canvasHeight: info.canvas_height,
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
  await refreshPreview();
}

export function selectLayer(idx: number) {
  setState("selectedLayerIdx", idx);
}

export async function addLayer(kind: string) {
  await bridge.addLayer(kind);
  await refreshLayerStack();
  await refreshPreview();
}

export async function refreshPreview() {
  try {
    const dataUrl = await bridge.renderPreview();
    if (!dataUrl) return;
    const response = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await response.blob());
    replaceBitmap(setPreviewBitmap, previewBitmap, bitmap);
  } catch (error) {
    console.warn("Failed to refresh preview", error);
  }
}
