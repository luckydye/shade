import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as bridge from "../bridge/index";
import type { RenderedTile } from "../viewport/types";
import type { CropAspectRatioPreset } from "../crop-aspect";

export interface LayerInfo {
  kind: "image" | "adjustment" | "crop" | "text";
  name?: string | null;
  visible: boolean;
  opacity: number;
  blend_mode?: string;
  has_mask?: boolean;
  mask_params?: bridge.MaskParamsInfo | null;
  adjustments?: bridge.AdjustmentValues | null;
  crop?: bridge.CropValues | null;
  text?: bridge.TextLayerValues | null;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export type ArtboardSource =
  | { kind: "path"; path: string }
  | { kind: "file"; file: File }
  | {
      kind: "peer";
      peerEndpointId: string;
      picture: bridge.SharedPicture;
    };

export interface ArtboardState {
  id: string;
  title: string;
  worldX: number;
  worldY: number;
  width: number;
  height: number;
  sourceBitDepth: string;
  source: ArtboardSource;
  activeMediaLibraryId: string | null;
  activeMediaItemId: string | null;
  activeFileHash: string | null;
  activeMediaRating: number | null;
  activeMediaBaseRating: number | null;
  previewTile: RenderedTile | null;
  backdropTile: RenderedTile | null;
}

export interface EditorState {
  currentView: "media" | "editor";
  activeMediaLibraryId: string | null;
  activeMediaItemId: string | null;
  artboards: ArtboardState[];
  selectedArtboardId: string | null;
  layers: LayerInfo[];
  canvasWidth: number;
  canvasHeight: number;
  sourceBitDepth: string;
  previewDisplayColorSpace: string;
  previewRenderWidth: number;
  previewRenderHeight: number;
  previewContentVersion: number;
  selectedLayerIdx: number;
  selectedLayerPart: "layer" | "mask";
  isLoading: boolean;
  isDownloading: boolean;
  webgpuAvailable: boolean;
  webgpuReason: string | null;
  loadError: string | null;
  viewportZoom: number;
  viewportCenterX: number;
  viewportCenterY: number;
  viewportScreenWidth: number;
  viewportScreenHeight: number;
  crop: CropRect;
  cropDraft: CropRect | null;
  isCropMode: boolean;
  loadingMediaSrc: string | null;
  fonts: bridge.FontInfo[];
}

export const [state, setState] = createStore<EditorState>({
  currentView: "media",
  activeMediaLibraryId: null,
  activeMediaItemId: null,
  artboards: [],
  selectedArtboardId: null,
  layers: [],
  canvasWidth: 0,
  canvasHeight: 0,
  sourceBitDepth: "Unknown",
  previewDisplayColorSpace: "Unknown",
  previewRenderWidth: 0,
  previewRenderHeight: 0,
  previewContentVersion: 0,
  selectedLayerIdx: -1,
  selectedLayerPart: "layer",
  isLoading: false,
  isDownloading: false,
  webgpuAvailable: true,
  webgpuReason: null,
  loadError: null,
  viewportZoom: 1,
  viewportCenterX: 0,
  viewportCenterY: 0,
  viewportScreenWidth: 0,
  viewportScreenHeight: 0,
  crop: { x: 0, y: 0, width: 0, height: 0, rotation: 0 },
  cropDraft: null,
  isCropMode: false,
  loadingMediaSrc: null,
  fonts: [],
});

export const [isDrawerOpen, setIsDrawerOpen] = createSignal(false);
export const [isAdjustmentSliderActive, setIsAdjustmentSliderActive] =
  createSignal(false);
export const [activeAdjustmentSliderId, setActiveAdjustmentSliderId] =
  createSignal<string | null>(null);
export const [viewportToneSample, setViewportToneSample] = createSignal<number | null>(null);
export const [cropAspectRatioPreset, setCropAspectRatioPreset] =
  createSignal<CropAspectRatioPreset>("free");

export function getSelectedArtboard() {
  if (!state.selectedArtboardId) {
    return null;
  }
  return state.artboards.find((artboard) => artboard.id === state.selectedArtboardId) ?? null;
}

export function setSelectedArtboardPreviewTile(tile: RenderedTile | null) {
  const artboard = getSelectedArtboard();
  if (!artboard) return;
  setState(
    "artboards",
    (candidate) => candidate.id === artboard.id,
    "previewTile",
    tile,
  );
}

export function setSelectedArtboardBackdropTile(tile: RenderedTile | null) {
  const artboard = getSelectedArtboard();
  if (!artboard) return;
  setState(
    "artboards",
    (candidate) => candidate.id === artboard.id,
    "backdropTile",
    tile,
  );
}

export function moveArtboardBy(id: string, deltaX: number, deltaY: number) {
  const artboard = state.artboards.find((candidate) => candidate.id === id);
  if (!artboard) {
    throw new Error("artboard not found");
  }
  setState(
    "artboards",
    (candidate) => candidate.id === id,
    {
      ...artboard,
      worldX: artboard.worldX + deltaX,
      worldY: artboard.worldY + deltaY,
    },
  );
}

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

export function resolveSelectedLayerPart(
  layers: LayerInfo[],
  currentIdx: number,
  nextIdx: number,
  currentPart: EditorState["selectedLayerPart"],
) {
  if (currentPart === "layer") {
    return "layer";
  }
  if (nextIdx !== currentIdx) {
    return "layer";
  }
  return layers[nextIdx]?.has_mask ? "mask" : "layer";
}

export function getLayerDefaultName(kind: LayerInfo["kind"]) {
  switch (kind) {
    case "image":
      return "Image";
    case "crop":
      return "Crop";
    case "adjustment":
      return "Adjustment";
    case "text":
      return "Text";
    default:
      throw new Error(`unknown layer kind: ${String(kind)}`);
  }
}

export function getLayerDisplayName(layer: Pick<LayerInfo, "kind" | "name">) {
  const name = layer.name?.trim();
  return name && name.length > 0 ? name : getLayerDefaultName(layer.kind);
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
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.rotation === b.rotation
  );
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
