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
const MAX_PREVIEW_DEVICE_PIXEL_RATIO = 1.25;
const MAX_PREVIEW_PIXEL_COUNT = 1_500_000;
let previewRefreshPending = false;
let previewRefreshPromise: Promise<void> | null = null;

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
  previewZoom: number;
  previewCenterX: number;
  previewCenterY: number;
  previewViewportWidth: number;
  previewViewportHeight: number;
}

const [state, setState] = createStore<EditorState>({
  layers: [],
  canvasWidth: 0,
  canvasHeight: 0,
  selectedLayerIdx: -1,
  isLoading: false,
  webgpuAvailable: true,
  previewZoom: 1,
  previewCenterX: 0,
  previewCenterY: 0,
  previewViewportWidth: 0,
  previewViewportHeight: 0,
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function fitPreviewSize(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  return {
    width: Math.max(1, Math.floor(imageWidth * scale)),
    height: Math.max(1, Math.floor(imageHeight * scale)),
  };
}

function capPreviewRenderSize(width: number, height: number) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const pixelCount = width * height;
  if (pixelCount <= MAX_PREVIEW_PIXEL_COUNT) return { width, height };
  const scale = Math.sqrt(MAX_PREVIEW_PIXEL_COUNT / pixelCount);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function clampPreviewCenter(zoom: number, centerX: number, centerY: number) {
  const cropWidth = state.canvasWidth / zoom;
  const cropHeight = state.canvasHeight / zoom;
  return {
    x: clamp(centerX, cropWidth * 0.5, state.canvasWidth - cropWidth * 0.5),
    y: clamp(centerY, cropHeight * 0.5, state.canvasHeight - cropHeight * 0.5),
  };
}

function getPreviewRequest(): bridge.PreviewRequest | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const fitted = fitPreviewSize(
    state.previewViewportWidth * Math.min(window.devicePixelRatio, MAX_PREVIEW_DEVICE_PIXEL_RATIO),
    state.previewViewportHeight * Math.min(window.devicePixelRatio, MAX_PREVIEW_DEVICE_PIXEL_RATIO),
    state.canvasWidth,
    state.canvasHeight,
  );
  const target = capPreviewRenderSize(fitted.width, fitted.height);
  if (target.width <= 0 || target.height <= 0) return null;
  const cropWidth = state.canvasWidth / state.previewZoom;
  const cropHeight = state.canvasHeight / state.previewZoom;
  const center = clampPreviewCenter(state.previewZoom, state.previewCenterX, state.previewCenterY);
  return {
    target_width: target.width,
    target_height: target.height,
    crop: {
      x: center.x - cropWidth * 0.5,
      y: center.y - cropHeight * 0.5,
      width: cropWidth,
      height: cropHeight,
    },
  };
}

export function getPreviewDisplaySize() {
  return fitPreviewSize(
    state.previewViewportWidth,
    state.previewViewportHeight,
    state.canvasWidth,
    state.canvasHeight,
  );
}

export function resetPreviewViewport() {
  setState({
    previewZoom: 1,
    previewCenterX: state.canvasWidth * 0.5,
    previewCenterY: state.canvasHeight * 0.5,
  });
  void refreshPreview();
}

export function setPreviewViewportSize(width: number, height: number) {
  const nextWidth = Math.max(0, Math.floor(width));
  const nextHeight = Math.max(0, Math.floor(height));
  if (nextWidth === state.previewViewportWidth && nextHeight === state.previewViewportHeight) return;
  setState({
    previewViewportWidth: nextWidth,
    previewViewportHeight: nextHeight,
  });
  void refreshPreview();
}

export function zoomPreview(multiplier: number) {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return;
  const zoom = clamp(state.previewZoom * multiplier, 1, 16);
  const center = clampPreviewCenter(zoom, state.previewCenterX, state.previewCenterY);
  setState({
    previewZoom: zoom,
    previewCenterX: center.x,
    previewCenterY: center.y,
  });
  void refreshPreview();
}

export function panPreview(deltaX: number, deltaY: number) {
  if (state.previewZoom <= 1 || state.previewViewportWidth <= 0 || state.previewViewportHeight <= 0) return;
  const display = getPreviewDisplaySize();
  if (display.width <= 0 || display.height <= 0) return;
  const cropWidth = state.canvasWidth / state.previewZoom;
  const cropHeight = state.canvasHeight / state.previewZoom;
  const center = clampPreviewCenter(
    state.previewZoom,
    state.previewCenterX - (deltaX / display.width) * cropWidth,
    state.previewCenterY - (deltaY / display.height) * cropHeight,
  );
  setState({
    previewCenterX: center.x,
    previewCenterY: center.y,
  });
  void refreshPreview();
}

function resetPreviewState(canvasWidth: number, canvasHeight: number) {
  setState({
    canvasWidth,
    canvasHeight,
    previewZoom: 1,
    previewCenterX: canvasWidth * 0.5,
    previewCenterY: canvasHeight * 0.5,
  });
}

export async function openImage(path: string) {
  setState("isLoading", true);
  replaceBitmap(setSourceBitmap, sourceBitmap, null);
  replaceBitmap(setPreviewBitmap, previewBitmap, null);
  setPreviewFrame(null);
  try {
    const info = await bridge.openImage(path);
    resetPreviewState(info.canvas_width, info.canvas_height);
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
    resetPreviewState(info.canvas_width, info.canvas_height);
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

async function performPreviewRefresh() {
  const request = getPreviewRequest();
  if (!request) return;
  const frame = await bridge.renderPreview(request);
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
}

export function refreshPreview() {
  previewRefreshPending = true;
  if (previewRefreshPromise) return previewRefreshPromise;
  previewRefreshPromise = (async () => {
    while (previewRefreshPending) {
      previewRefreshPending = false;
      await performPreviewRefresh();
    }
    previewRefreshPromise = null;
  })();
  return previewRefreshPromise;
}
