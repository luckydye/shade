import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";

export interface PreviewImage {
  image: ImageData;
  crop: bridge.PreviewCrop;
  viewportX: number;
  viewportY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PreviewContextImage {
  image: ImageData;
  crop: bridge.PreviewCrop;
}

export interface LayerInfo {
  kind: "image" | "adjustment" | "crop";
  visible: boolean;
  opacity: number;
  blend_mode?: string;
  has_mask?: boolean;
  mask_params?: bridge.MaskParamsInfo | null;
  adjustments?: bridge.AdjustmentValues | null;
  crop?: bridge.CropValues | null;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface EditorState {
  currentView: "media" | "editor";
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
  crop: CropRect;
  cropDraft: CropRect | null;
  isCropMode: boolean;
  loadingMediaSrc: string | null;
}

export const [previewFrame, setPreviewFrame] = createSignal<PreviewImage | null>(null);
export const [previewContextFrame, setPreviewContextFrame] =
  createSignal<PreviewContextImage | null>(null);

export const [state, setState] = createStore<EditorState>({
  currentView: "media",
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
  crop: { x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  cropDraft: null,
  isCropMode: false,
  loadingMediaSrc: null,
});

export const [isDrawerOpen, setIsDrawerOpen] = createSignal(false);

export function resolveSelectedLayerIdx(layers: LayerInfo[], currentIdx: number) {
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

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function fullCanvasCrop(
  width = state.canvasWidth,
  height = state.canvasHeight,
): CropRect {
  return { x: 0, y: 0, width, height, rotation: 0 };
}

export function normalizeCropRect(
  rect: CropRect,
  canvasWidth = state.canvasWidth,
  canvasHeight = state.canvasHeight,
): CropRect {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error("cannot normalize crop without a loaded image");
  }
  const x = clamp(Math.round(rect.x), 0, canvasWidth - 1);
  const y = clamp(Math.round(rect.y), 0, canvasHeight - 1);
  const maxWidth = canvasWidth - x;
  const maxHeight = canvasHeight - y;
  const width = clamp(Math.round(rect.width), 1, maxWidth);
  const height = clamp(Math.round(rect.height), 1, maxHeight);
  return { x, y, width, height, rotation: rect.rotation };
}

export function cropRectsMatch(a: CropRect, b: CropRect) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.rotation === b.rotation;
}

export function selectedLayerIsCrop() {
  return (
    state.selectedLayerIdx >= 0 && state.layers[state.selectedLayerIdx]?.kind === "crop"
  );
}

export function getCommittedCropRect() {
  const cropLayer = state.layers.find(
    (layer) => layer.kind === "crop" && layer.visible && layer.crop,
  );
  if (cropLayer?.crop) {
    return cropLayer.crop;
  }
  return fullCanvasCrop();
}

export function getDraftCropRect() {
  return state.cropDraft ?? getCommittedCropRect();
}

export function hasActiveCrop() {
  return !cropRectsMatch(getCommittedCropRect(), fullCanvasCrop());
}

export function findCropLayerIdx() {
  return state.layers.findIndex((layer) => layer.kind === "crop");
}
