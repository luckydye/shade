import * as bridge from "../bridge/index";
import {
  fullCanvasCrop,
  LayerInfo,
  normalizeCropRect,
  resolveSelectedLayerIdx,
  setState,
  state,
} from "./editor-store";
import { clearPreviewTiles, refreshPreview, resetViewport } from "../viewport/preview";

let pendingEdits = new Map<string, Record<string, unknown>>();
let editFlushPromise: Promise<void> | null = null;
let editFlushWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

function getEditKey(params: Record<string, unknown>) {
  const layerIdx = params.layer_idx;
  const op = params.op;
  if (typeof layerIdx !== "number") {
    throw new Error("edit batching requires a numeric layer_idx");
  }
  if (typeof op !== "string" || op.length === 0) {
    throw new Error("edit batching requires a string op");
  }
  return `${layerIdx}:${op}`;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function flushPendingEdits() {
  await nextAnimationFrame();
  const batch = [...pendingEdits.values()];
  pendingEdits = new Map();
  if (batch.length === 0) {
    return;
  }
  for (const params of batch) {
    await bridge.applyEdit(params);
  }
  setState("previewContentVersion", (version) => version + 1);
  await refreshPreview();
  if (pendingEdits.size > 0) {
    await flushPendingEdits();
  }
}

function queueEdit(params: Record<string, unknown>) {
  const key = getEditKey(params);
  const current = pendingEdits.get(key);
  pendingEdits.set(key, current ? { ...current, ...params } : params);
  const completion = new Promise<void>((resolve, reject) => {
    editFlushWaiters.push({ resolve, reject });
  });
  if (editFlushPromise) {
    return completion;
  }
  editFlushPromise = (async () => {
    try {
      await flushPendingEdits();
      const waiters = editFlushWaiters;
      editFlushWaiters = [];
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      const waiters = editFlushWaiters;
      editFlushWaiters = [];
      for (const waiter of waiters) waiter.reject(error);
    } finally {
      editFlushPromise = null;
    }
  })();
  return completion;
}

function getEmptyAdjustments(): NonNullable<LayerInfo["adjustments"]> {
  return {
    tone: null,
    curves: null,
    color: null,
    vignette: null,
    sharpen: null,
    grain: null,
    glow: null,
    hsl: null,
    denoise: null,
  };
}

async function runLayerMutation(work: () => Promise<unknown>) {
  await work();
  await refreshLayerStack();
  await refreshPreview();
}

export async function refreshLayerStack() {
  const info = await bridge.getLayerStack();
  const layers = info.layers as LayerInfo[];
  setState({
    layers,
    canvasWidth: info.canvas_width,
    canvasHeight: info.canvas_height,
    previewContentVersion: info.generation,
    selectedLayerIdx:
      layers.length === 0 ? -1 : resolveSelectedLayerIdx(layers, state.selectedLayerIdx),
  });
}

export async function setLayerVisible(idx: number, visible: boolean) {
  await runLayerMutation(() => bridge.setLayerVisible(idx, visible));
}

export async function setLayerOpacity(idx: number, opacity: number) {
  await runLayerMutation(() => bridge.setLayerOpacity(idx, opacity));
}

export async function renameLayer(idx: number, name: string | null) {
  if (idx < 0 || idx >= state.layers.length) {
    throw new Error("layer index is out of bounds");
  }
  await bridge.renameLayer(idx, name);
  await refreshLayerStack();
}

export async function deleteLayer(idx: number) {
  await bridge.deleteLayer(idx);
  await refreshLayerStack();
  if (state.layers.length === 0) {
    clearPreviewTiles();
  }
  await refreshPreview();
}

function getMovedLayerIndex(idx: number, fromIdx: number, toIdx: number) {
  if (idx === fromIdx) {
    return toIdx > fromIdx ? toIdx - 1 : toIdx;
  }
  if (toIdx > fromIdx && idx > fromIdx && idx < toIdx) {
    return idx - 1;
  }
  if (toIdx < fromIdx && idx >= toIdx && idx < fromIdx) {
    return idx + 1;
  }
  return idx;
}

function applyCropLayerEdit(layerIdx: number, params: Record<string, unknown>) {
  if (params.op !== "crop") {
    throw new Error("crop layers only accept the crop op");
  }
  setState("layers", layerIdx, "crop", {
    x: params.crop_x as number,
    y: params.crop_y as number,
    width: params.crop_width as number,
    height: params.crop_height as number,
    rotation:
      (params.crop_rotation as number | undefined) ??
      state.layers[layerIdx]?.crop?.rotation ??
      0,
  });
}

function applyAdjustmentLayerEdit(layerIdx: number, params: Record<string, unknown>) {
  const adjustments = state.layers[layerIdx]?.adjustments ?? getEmptyAdjustments();
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
      return;
    case "color":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        color: {
          saturation: params.saturation as number,
          vibrancy: params.vibrancy as number,
          temperature: params.temperature as number,
          tint: params.tint as number,
        },
      });
      return;
    case "curves":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        curves: {
          lut_r: adjustments.curves?.lut_r ?? [],
          lut_g: adjustments.curves?.lut_g ?? [],
          lut_b: adjustments.curves?.lut_b ?? [],
          lut_master: adjustments.curves?.lut_master ?? [],
          per_channel: adjustments.curves?.per_channel ?? false,
          control_points: params.curve_points as bridge.CurveControlPoint[] | undefined,
        },
      });
      return;
    case "vignette":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        vignette: { amount: params.vignette_amount as number },
      });
      return;
    case "sharpen":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        sharpen: { amount: params.sharpen_amount as number },
      });
      return;
    case "grain":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        grain: { amount: params.grain_amount as number, size: params.grain_size as number },
      });
      return;
    case "glow":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        glow: { amount: params.glow_amount as number },
      });
      return;
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
      return;
    case "denoise":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        denoise: {
          luma_strength: params.denoise_luma_strength as number,
          chroma_strength: params.denoise_chroma_strength as number,
          mode: (params.denoise_mode as number | undefined) ?? 0,
        },
      });
      return;
    default:
      throw new Error(`unknown edit op: ${String(params.op)}`);
  }
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
  if (layer.kind === "crop") {
    applyCropLayerEdit(layerIdx, params);
    await queueEdit(params);
    return;
  }
  if (layer.kind !== "adjustment") {
    throw new Error("applyEdit target layer must be an adjustment or crop layer");
  }
  applyAdjustmentLayerEdit(layerIdx, params);
  await queueEdit(params);
}

export function selectLayer(idx: number) {
  if (idx === state.selectedLayerIdx) return;
  setState("selectedLayerIdx", idx);
}

export function startCropMode() {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
    throw new Error("cannot start crop mode without a loaded image");
  }
  setState({
    isCropMode: true,
    cropDraft: state.crop,
  });
  void refreshPreview();
}

export function cancelCropMode() {
  if (!state.isCropMode) return;
  setState({
    isCropMode: false,
    cropDraft: null,
  });
  void refreshPreview();
}

export function updateCropDraft(next: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}) {
  if (!state.isCropMode) {
    throw new Error("cannot update crop draft when crop mode is inactive");
  }
  setState("cropDraft", normalizeCropRect(next));
}

export function resetCrop() {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) {
    throw new Error("cannot reset crop without a loaded image");
  }
  const crop = fullCanvasCrop();
  setState({
    crop,
    cropDraft: state.isCropMode ? crop : null,
  });
  resetViewport();
}

export function applyCrop() {
  if (!state.isCropMode || !state.cropDraft) {
    throw new Error("cannot apply crop without an active draft");
  }
  const crop = normalizeCropRect(state.cropDraft);
  setState({
    crop,
    cropDraft: null,
    isCropMode: false,
    viewportZoom: 1,
    viewportCenterX: crop.x + crop.width * 0.5,
    viewportCenterY: crop.y + crop.height * 0.5,
  });
  void refreshPreview();
}

export async function applyGradientMask(params: bridge.GradientMaskParams) {
  await runLayerMutation(() => bridge.applyGradientMask(params));
}

export async function removeMask(idx: number) {
  await runLayerMutation(() => bridge.removeMask(idx));
}

export async function addLayer(kind: string, position: number) {
  let idx = await bridge.addLayer(kind);
  await refreshLayerStack();
  if (position < 0 || position > state.layers.length) {
    throw new Error("layer insertion position is out of bounds");
  }
  if (idx < 0 || idx >= state.layers.length) {
    throw new Error("new layer could not be resolved after insertion");
  }
  if (idx !== position) {
    await bridge.moveLayer(idx, position);
    await refreshLayerStack();
    idx = getMovedLayerIndex(idx, idx, position);
  }
  setState("selectedLayerIdx", idx);
  await refreshPreview();
}

export async function moveLayer(fromIdx: number, toIdx: number) {
  if (fromIdx === toIdx || fromIdx + 1 === toIdx) {
    return;
  }
  if (fromIdx < 0 || fromIdx >= state.layers.length) {
    throw new Error("source layer index is out of bounds");
  }
  if (toIdx < 0 || toIdx > state.layers.length) {
    throw new Error("target layer index is out of bounds");
  }
  const nextSelectedIdx =
    state.selectedLayerIdx < 0
      ? -1
      : getMovedLayerIndex(state.selectedLayerIdx, fromIdx, toIdx);
  await bridge.moveLayer(fromIdx, toIdx);
  await refreshLayerStack();
  if (nextSelectedIdx >= 0) {
    setState("selectedLayerIdx", nextSelectedIdx);
  }
  await refreshPreview();
}

export async function listPresets() {
  return bridge.listPresets();
}

export async function listSnapshots() {
  return bridge.listSnapshots();
}

export async function savePreset(name: string) {
  return bridge.savePreset(name);
}

export async function loadPreset(name: string) {
  await bridge.loadPreset(name);
  await refreshLayerStack();
  await refreshPreview();
}

export async function saveSnapshot() {
  return bridge.saveSnapshot();
}

export async function loadSnapshot(id: string) {
  await bridge.loadSnapshot(id);
  await refreshLayerStack();
  await refreshPreview();
}
