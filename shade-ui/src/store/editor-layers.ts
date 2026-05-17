import type {
  CurveControlPoint,
  GradientMaskParams,
  TextStylePatch,
  TextTransformValues,
} from "../bridge/index";
import {
  applyPresetSnapshot as bridgeApplyPresetSnapshot,
  loadPreset as bridgeLoadPreset,
  loadSnapshot as bridgeLoadSnapshot,
} from "../data/batch";
import { onChannelMessage } from "../data/events";
import {
  addLayer as bridgeAddLayer,
  addTextLayer as bridgeAddTextLayer,
  applyEdit as bridgeApplyEdit,
  applyGradientMask as bridgeApplyGradientMask,
  createBrushMask as bridgeCreateBrushMask,
  deleteLayer as bridgeDeleteLayer,
  getLayerStack,
  getStackSnapshot,
  moveLayer as bridgeMoveLayer,
  removeMask as bridgeRemoveMask,
  renameLayer as bridgeRenameLayer,
  replaceStack,
  setLayerOpacity as bridgeSetLayerOpacity,
  setLayerVisible as bridgeSetLayerVisible,
  setTextTransform as bridgeSetTextTransform,
  stampBrushMask as bridgeStampBrushMask,
  updateTextContent as bridgeUpdateTextContent,
  updateTextStyle as bridgeUpdateTextStyle,
} from "../data/layer-stack";
import { isTauriRuntime } from "../data/runtime";
import { clearPreviewTiles, refreshPreview, resetViewport } from "../viewport/preview";
import {
  fullCanvasCrop,
  getSelectedArtboard,
  isAdjustmentSliderActive,
  type LayerInfo,
  normalizeCropRect,
  resolveSelectedLayerIdx,
  resolveSelectedLayerPart,
  setState,
  state,
} from "./editor-store";
import { onRestore, recordSnapshot } from "./history";

interface LayerStackInfoLike {
  layers: LayerInfo[];
  canvas_width: number;
  canvas_height: number;
  generation: number;
}

function applyLayerStackInfo(info: LayerStackInfoLike) {
  const layers = info.layers;
  const selectedLayerIdx =
    layers.length === 0 ? -1 : resolveSelectedLayerIdx(layers, state.selectedLayerIdx);
  setState({
    layers,
    canvasWidth: info.canvas_width,
    canvasHeight: info.canvas_height,
    previewContentVersion: info.generation,
    selectedLayerIdx,
    selectedLayerPart: resolveSelectedLayerPart(
      layers,
      state.selectedLayerIdx,
      selectedLayerIdx,
      state.selectedLayerPart,
    ),
  });
}

// Subscribe to authoritative layer-stack pushes from Rust. The subscriber is
// installed once at module load; every Rust-side mutation site broadcasts a
// `LayerStackSnapshot` after persisting, so the store reflects the
// post-mutation state without callers needing to invoke `get_layer_stack`.
onChannelMessage("layer_stack_snapshot", (msg) => {
  applyLayerStackInfo(msg.stack as LayerStackInfoLike);
});

onRestore(async (data) => {
  await replaceStack(data);
  await refreshLayerStack();
  await refreshPreview();
});

async function captureAndRecordSnapshot() {
  const data = await getStackSnapshot();
  recordSnapshot(data);
}

let deferredHistorySnapshot = false;

export function queueHistorySnapshot() {
  if (isAdjustmentSliderActive()) {
    deferredHistorySnapshot = true;
    return;
  }
  void captureAndRecordSnapshot();
}

export async function flushDeferredHistorySnapshot() {
  if (!deferredHistorySnapshot) {
    return;
  }
  deferredHistorySnapshot = false;
  await captureAndRecordSnapshot();
}

let pendingEdits = new Map<string, Record<string, unknown>>();
let editFlushPromise: Promise<void> | null = null;
let editFlushWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> =
  [];

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
    await bridgeApplyEdit(params);
  }
  setState("previewContentVersion", (version) => version + 1);
  await refreshPreview();
  if (pendingEdits.size > 0) {
    await flushPendingEdits();
  } else {
    queueHistorySnapshot();
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
    ls_curve: null,
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

/**
 * In the Tauri runtime the layer stack is pushed reactively via
 * `LayerStackSnapshot` — callers no longer need to refetch after mutations.
 * This function remains as a fallback for the browser worker path (which has
 * no channel) and as a manual sync trigger when starting up before any
 * mutation has fired.
 */
export async function refreshLayerStack() {
  if (await isTauriRuntime()) {
    // Rust broadcasts on every mutation and on initial channel registration —
    // store is already kept in sync by the subscriber.
    return;
  }
  const info = await getLayerStack();
  applyLayerStackInfo(info as unknown as LayerStackInfoLike);
}

export async function setLayerVisible(idx: number, visible: boolean) {
  await runLayerMutation(() => bridgeSetLayerVisible(idx, visible));
}

export async function setLayerOpacity(idx: number, opacity: number) {
  await runLayerMutation(() => bridgeSetLayerOpacity(idx, opacity));
}

export async function renameLayer(idx: number, name: string | null) {
  if (idx < 0 || idx >= state.layers.length) {
    throw new Error("layer index is out of bounds");
  }
  await bridgeRenameLayer(idx, name);
  await refreshLayerStack();
}

export async function deleteLayer(idx: number) {
  const deletedSelectedLayer = idx === state.selectedLayerIdx;
  await bridgeDeleteLayer(idx);
  await refreshLayerStack();
  if (deletedSelectedLayer) {
    setState("selectedLayerPart", "layer");
  }
  if (state.layers.length === 0) {
    clearPreviewTiles();
  }
  await refreshPreview();
  queueHistorySnapshot();
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
          control_points: params.curve_points as CurveControlPoint[] | undefined,
        },
      });
      return;
    case "ls_curve":
      setState("layers", layerIdx, "adjustments", {
        ...adjustments,
        ls_curve: {
          lut: adjustments.ls_curve?.lut ?? [],
          control_points: params.curve_points as CurveControlPoint[] | undefined,
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
        grain: {
          amount: params.grain_amount as number,
          size: params.grain_size as number,
        },
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
  if (idx === state.selectedLayerIdx && state.selectedLayerPart === "layer") return;
  setState({
    selectedLayerIdx: idx,
    selectedLayerPart: "layer",
  });
}

export function selectMaskLayer(idx: number) {
  if (!state.layers[idx]?.has_mask) {
    throw new Error("mask selection requires a masked layer");
  }
  if (idx === state.selectedLayerIdx && state.selectedLayerPart === "mask") return;
  setState({
    selectedLayerIdx: idx,
    selectedLayerPart: "mask",
  });
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

export async function applyGradientMask(params: GradientMaskParams) {
  await runLayerMutation(() => bridgeApplyGradientMask(params));
  selectMaskLayer(params.layer_idx);
}

export async function removeMask(idx: number) {
  await runLayerMutation(() => bridgeRemoveMask(idx));
  if (idx === state.selectedLayerIdx && state.selectedLayerPart === "mask") {
    selectLayer(idx);
  }
}

export async function createBrushMask(idx: number) {
  await runLayerMutation(() => bridgeCreateBrushMask(idx));
  selectMaskLayer(idx);
}

export async function stampBrushMask(
  layerIdx: number,
  cx: number,
  cy: number,
  radius: number,
  softness: number,
  erase: boolean,
) {
  await bridgeStampBrushMask(layerIdx, cx, cy, radius, softness, erase);
}

export async function addLayer(kind: string, position: number) {
  await bridgeAddLayer(kind);
  // The Rust side always appends the new layer, then broadcasts the new
  // stack via LayerStackSnapshot. The bridge mutation awaits the snapshot
  // before resolving, so state.layers is up-to-date here.
  await refreshLayerStack();
  if (position < 0 || position > state.layers.length) {
    throw new Error("layer insertion position is out of bounds");
  }
  let idx = state.layers.length - 1;
  if (idx < 0) {
    throw new Error("new layer could not be resolved after insertion");
  }
  if (idx !== position) {
    await bridgeMoveLayer(idx, position);
    await refreshLayerStack();
    idx = getMovedLayerIndex(idx, idx, position);
  }
  setState("selectedLayerIdx", idx);
  setState("selectedLayerPart", "layer");
  await refreshPreview();
  queueHistorySnapshot();
  return idx;
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
  const selectedLayerPart = state.selectedLayerPart;
  await bridgeMoveLayer(fromIdx, toIdx);
  await refreshLayerStack();
  if (nextSelectedIdx >= 0) {
    setState({
      selectedLayerIdx: nextSelectedIdx,
      selectedLayerPart,
    });
  }
  await refreshPreview();
  queueHistorySnapshot();
}

export async function loadPreset(name: string) {
  await bridgeLoadPreset(name);
  await refreshLayerStack();
  await refreshPreview();
  queueHistorySnapshot();
}

export async function applyPresetSnapshot(name: string) {
  const artboard = getSelectedArtboard();
  const imagePath = artboard?.source.kind === "path" ? artboard.source.path : null;
  const snapshot = await bridgeApplyPresetSnapshot(name, imagePath);
  await refreshLayerStack();
  await refreshPreview();
  queueHistorySnapshot();
  return snapshot;
}

export async function loadSnapshot(id: string) {
  await bridgeLoadSnapshot(id);
  await refreshLayerStack();
  await refreshPreview();
  queueHistorySnapshot();
}

// ── Text layers & fonts ────────────────────────────────────────────────

export async function addTextLayer(
  content: string,
  fontId: number,
  sizePx: number,
  position: number,
) {
  await bridgeAddTextLayer(content, fontId, sizePx);
  // Rust appends the new text layer and broadcasts the new stack via
  // LayerStackSnapshot before the mutation resolves; the appended layer is
  // therefore at `state.layers.length - 1`.
  await refreshLayerStack();
  if (position < 0 || position > state.layers.length) {
    throw new Error("layer insertion position is out of bounds");
  }
  let idx = state.layers.length - 1;
  if (idx < 0) {
    throw new Error("new layer could not be resolved after insertion");
  }
  if (idx !== position) {
    await bridgeMoveLayer(idx, position);
    await refreshLayerStack();
    idx = getMovedLayerIndex(idx, idx, position);
  }
  setState("selectedLayerIdx", idx);
  await refreshPreview();
  queueHistorySnapshot();
  return idx;
}

export async function updateTextContent(layerIdx: number, content: string) {
  await runLayerMutation(() => bridgeUpdateTextContent(layerIdx, content));
}

export async function updateTextStyle(layerIdx: number, patch: TextStylePatch) {
  await runLayerMutation(() => bridgeUpdateTextStyle(layerIdx, patch));
}

export async function setTextTransform(
  layerIdx: number,
  transform: TextTransformValues,
) {
  await runLayerMutation(() => bridgeSetTextTransform(layerIdx, transform));
}

