import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

const [previewFrame, setPreviewFrame] = createSignal<ImageData | null>(null);
export { previewFrame };
type PreviewQuality = "interactive" | "final";
const INTERACTIVE_PREVIEW_DEVICE_PIXEL_RATIO = 0.75;
const FINAL_PREVIEW_DEVICE_PIXEL_RATIO = 1.25;
const INTERACTIVE_PREVIEW_PIXEL_COUNT = 300_000;
const FINAL_PREVIEW_PIXEL_COUNT = 1_500_000;
let previewRefreshVersion = 0;
let previewRefreshQueued: { version: number; quality: PreviewQuality } | null = null;
let previewRefreshPromise: Promise<void> | null = null;

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
  sourceBitDepth: string;
  previewDisplayColorSpace: string;
  previewRenderWidth: number;
  previewRenderHeight: number;
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
  sourceBitDepth: "Unknown",
  previewDisplayColorSpace: "Unknown",
  previewRenderWidth: 0,
  previewRenderHeight: 0,
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

export const [isDrawerOpen, setIsDrawerOpen] = createSignal(false);

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

function capPreviewRenderSize(width: number, height: number, maxPixelCount: number) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const pixelCount = width * height;
  if (pixelCount <= maxPixelCount) return { width, height };
  const scale = Math.sqrt(maxPixelCount / pixelCount);
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

function getPreviewRequest(quality: PreviewQuality): bridge.PreviewRequest | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const devicePixelRatio = quality === "interactive"
    ? INTERACTIVE_PREVIEW_DEVICE_PIXEL_RATIO
    : FINAL_PREVIEW_DEVICE_PIXEL_RATIO;
  const maxPixelCount = quality === "interactive"
    ? INTERACTIVE_PREVIEW_PIXEL_COUNT
    : FINAL_PREVIEW_PIXEL_COUNT;
  const fitted = fitPreviewSize(
    state.previewViewportWidth * Math.min(window.devicePixelRatio, devicePixelRatio),
    state.previewViewportHeight * Math.min(window.devicePixelRatio, devicePixelRatio),
    state.canvasWidth,
    state.canvasHeight,
  );
  const target = capPreviewRenderSize(fitted.width, fitted.height, maxPixelCount);
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

export function closeImage() {
  setPreviewFrame(null);
  setState({
    layers: [],
    canvasWidth: 0,
    canvasHeight: 0,
    isLoading: false,
    selectedLayerIdx: -1,
    previewZoom: 1,
    previewCenterX: 0,
    previewCenterY: 0,
  });
}

export async function openImage(path: string) {
  setState("isLoading", true);
  setPreviewFrame(null);
  try {
    const info = await bridge.openImage(path);
    resetPreviewState(info.canvas_width, info.canvas_height);
    setState("sourceBitDepth", info.source_bit_depth);
    await refreshLayerStack();
    await refreshPreview();
  } finally {
    setState("isLoading", false);
  }
}

export async function openImageFile(file: File) {
  setPreviewFrame(null);

  setState("isLoading", true);
  try {
    const info = await bridge.openImageFile(file);
    resetPreviewState(info.canvas_width, info.canvas_height);
    setState("sourceBitDepth", info.source_bit_depth);
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
  const layerIdx = params.layer_idx;
  if (typeof layerIdx !== "number") {
    throw new Error("applyEdit requires a numeric layer_idx");
  }
  const layer = state.layers[layerIdx];
  if (!layer) {
    throw new Error("applyEdit target layer is out of bounds");
  }
  if (layer.kind !== "adjustment") {
    throw new Error("applyEdit target layer must be an adjustment layer");
  }
  const adjustments = layer.adjustments ?? {
    tone: null,
    curves: null,
    color: null,
    vignette: null,
    sharpen: null,
    grain: null,
    hsl: null,
  };
  switch (params.op) {
    case "tone":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        tone: {
          exposure: params.exposure as number,
          contrast: params.contrast as number,
          blacks: params.blacks as number,
          whites: params.whites as number,
          highlights: params.highlights as number,
          shadows: params.shadows as number,
          gamma: params.gamma as number,
        },
      });
      break;
    case "color":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        color: {
          saturation: params.saturation as number,
          temperature: params.temperature as number,
          tint: params.tint as number,
        },
      });
      break;
    case "curves":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        curves: {
          lut_r: params.lut_r as number[],
          lut_g: params.lut_g as number[],
          lut_b: params.lut_b as number[],
          lut_master: params.lut_master as number[],
          per_channel: params.per_channel as boolean,
        },
      });
      break;
    case "vignette":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        vignette: { amount: params.vignette_amount as number },
      });
      break;
    case "sharpen":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        sharpen: { amount: params.sharpen_amount as number },
      });
      break;
    case "grain":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        grain: { amount: params.grain_amount as number },
      });
      break;
    case "hsl":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        hsl: {
          red_hue: params.red_hue as number,
          red_sat: params.red_sat as number,
          red_lum: params.red_lum as number,
          green_hue: params.green_hue as number,
          green_sat: params.green_sat as number,
          green_lum: params.green_lum as number,
          blue_hue: params.blue_hue as number,
          blue_sat: params.blue_sat as number,
          blue_lum: params.blue_lum as number,
        },
      });
      break;
    default:
      throw new Error(`unknown edit op: ${String(params.op)}`);
  }
  await bridge.applyEdit(params);
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
  const queued = previewRefreshQueued;
  if (!queued) return;
  previewRefreshQueued = null;
  const request = getPreviewRequest(queued.quality);
  if (!request) return;
  const frame = await bridge.renderPreview(request);
  if (queued.quality === "final" && queued.version !== previewRefreshVersion) return;
  if (frame.kind === "rgba-float16") {
    if (frame.width === 0 || frame.height === 0) return;
    setState({
      previewDisplayColorSpace: frame.colorSpace === "display-p3" ? "Display P3" : frame.colorSpace,
      previewRenderWidth: frame.width,
      previewRenderHeight: frame.height,
    });
    setPreviewFrame(new ImageData(frame.pixels as any, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.colorSpace,
    } as any));
    return;
  }
  if (frame.kind === "rgba") {
    if (frame.width === 0 || frame.height === 0) return;
    setState({
      previewDisplayColorSpace: "sRGB",
      previewRenderWidth: frame.width,
      previewRenderHeight: frame.height,
    });
    const pixels = new Uint8ClampedArray(frame.pixels.length);
    pixels.set(frame.pixels);
    setPreviewFrame(new ImageData(pixels, frame.width, frame.height));
    return;
  }
}

function queuePreviewRefresh(version: number, quality: PreviewQuality) {
  if (
    previewRefreshQueued
    && previewRefreshQueued.version === version
    && previewRefreshQueued.quality === "final"
  ) {
    return;
  }
  previewRefreshQueued = { version, quality };
  if (previewRefreshPromise) return previewRefreshPromise;
  previewRefreshPromise = (async () => {
    while (previewRefreshQueued) {
      await performPreviewRefresh();
    }
    previewRefreshPromise = null;
  })();
  return previewRefreshPromise;
}

export function refreshPreview(mode: "progressive" | "final" = "progressive") {
  previewRefreshVersion += 1;
  const version = previewRefreshVersion;
  if (mode === "final") {
    return queuePreviewRefresh(version, "final");
  }
  const interactive = queuePreviewRefresh(version, "interactive") ?? Promise.resolve();
  return interactive.finally(() => {
    if (version !== previewRefreshVersion) return;
    return queuePreviewRefresh(version, "final") ?? Promise.resolve();
  });
}
