import { Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  applyEdit,
  applyGradientMask,
  closeArtboard,
  cropAspectRatioPreset,
  getSelectedArtboard,
  getCommittedCropRect,
  getViewportZoomPercent,
  moveArtboardBy,
  openImageFile,
  offsetViewportCenter,
  panViewport,
  backdropTile,
  previewTile,
  refreshPreview,
  resetViewport,
  selectArtboard,
  setCropAspectRatioPreset,
  setViewportScreenSize,
  setViewportToneSample,
  stampBrushMask,
  state,
  zoomViewport,
} from "../store/editor";
import { getMaskThumbnail, setMediaRating, type MaskParamsInfo } from "../bridge/index";
import { compositeArtboard } from "../viewport/compositor";
import { buildTransform, screenToWorld, worldToScreen } from "../viewport/transform";
import { getViewportFitRef } from "../viewport/preview";
import { makeBrushCursor } from "../viewport/brush-cursor";
import type { WorldTransform } from "../viewport/transform";
import { clamp, setState, type ArtboardState } from "../store/editor-store";
import {
  clampAspectSize,
  constrainCropDragToAspectRatio,
  CROP_ASPECT_RATIO_OPTIONS,
  fitCropRectToAspectRatio,
  resizeCropFromHandle,
  resolveCropAspectRatio,
  type CropAspectRatioPreset,
  type CropResizeHandle,
} from "../crop-aspect";
import { Button } from "./Button";
import { MediaRating } from "./MediaRating";
import { Slider } from "./Slider";

type CropHandle =
  | "move"
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left"
  | "rotate";

type MaskHandle = "start" | "end" | "center" | "edge";
type PressedArtboardChrome =
  | { kind: "title"; artboardId: string }
  | { kind: "close"; artboardId: string }
  | null;

const HANDLE_SIZE = 10;
const ARTBOARD_TITLE_HEIGHT = 24;
const ARTBOARD_TITLE_PADDING_X = 10;
const ARTBOARD_TITLE_MAX_WIDTH = 220;
const ARTBOARD_CLOSE_SIZE = 18;
const ARTBOARD_CLOSE_MARGIN = 6;
const ARTBOARD_CHROME_FADE = 0;
const ARTBOARD_DRAG_THRESHOLD = 6;
const CROP_ROTATION_SNAP_STEP = Math.PI / 36;

function mediaRatingIdForArtboard(artboard: ArtboardState | null) {
  if (!artboard) {
    return null;
  }
  switch (artboard.source.kind) {
    case "path":
      return artboard.source.path;
    case "peer":
      return `peer:${artboard.source.peerEndpointId}:${artboard.source.picture.id}`;
    case "file":
      return null;
    default:
      throw new Error("unknown artboard source");
  }
}

function rotatePoint(x: number, y: number, centerX: number, centerY: number, angle: number) {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: centerX + deltaX * cos - deltaY * sin,
    y: centerY + deltaX * sin + deltaY * cos,
  };
}

function isMissingArtboardError(error: unknown) {
  return error instanceof Error && error.message === "artboard not found";
}

export const Viewport: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  const [pressedArtboardChrome, setPressedArtboardChrome] =
    createSignal<PressedArtboardChrome>(null);
  const [draftCrop, setDraftCrop] = createSignal<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  } | null>(null);
  const [draftMask, setDraftMask] = createSignal<MaskParamsInfo | null>(null);
  const [brushSize, setBrushSize] = createSignal(100);
  const [brushSoftness, setBrushSoftness] = createSignal(0.5);
  let brushOverlayCanvas: HTMLCanvasElement | null = null;
  // R8 pixel values (0–255) at thumbnail resolution — single source of truth for the overlay
  let brushOverlayPixels: Uint8Array | null = null;
  const BRUSH_OVERLAY_MAX = 512;
  const [loadingArtboardImage, setLoadingArtboardImage] =
    createSignal<HTMLImageElement | null>(null);
  const [isSavingRating, setIsSavingRating] = createSignal(false);
  const activePointers = new Map<number, { x: number; y: number }>();
  let lastStagePointer: { x: number; y: number } | null = null;
  let toneSmoothingFrame: number | null = null;
  let smoothedToneSample: number | null = null;
  let targetToneSample: number | null = null;
  let lastToneSampleTime = 0;
  let gesture:
    | {
        kind: "pan";
        x: number;
        y: number;
        startX: number;
        startY: number;
        moved: boolean;
        tapArtboardId: string | null;
      }
    | { kind: "pinch"; dist: number; midX: number; midY: number }
    | {
        kind: "crop";
        pointerId: number;
        handle: CropHandle;
        startX: number;
        startY: number;
        crop: { x: number; y: number; width: number; height: number; rotation: number };
      }
    | {
        kind: "mask";
        pointerId: number;
        handle: MaskHandle;
        startX: number;
        startY: number;
        params: MaskParamsInfo;
      }
    | {
        kind: "artboard";
        pointerId: number;
        artboardId: string;
        draggable: boolean;
        moved: boolean;
        startX: number;
        startY: number;
        x: number;
        y: number;
      }
    | {
        kind: "brush_paint";
        pointerId: number;
        lastImgX: number;
        lastImgY: number;
        erase: boolean;
      }
    | null = null;

  const selectedCropLayer = () => {
    const layer = state.layers[state.selectedLayerIdx];
    return layer?.kind === "crop" && layer.crop ? layer : null;
  };

  const activeCrop = () => draftCrop() ?? selectedCropLayer()?.crop ?? null;
  const selectedCropAspectRatio = () =>
    resolveCropAspectRatio(cropAspectRatioPreset(), state.canvasWidth, state.canvasHeight);

  const selectedMaskParams = (): MaskParamsInfo | null => {
    const layer = state.layers[state.selectedLayerIdx];
    if (!layer?.has_mask || !layer.mask_params) return null;
    return layer.mask_params;
  };

  const shouldShowZoomIndicator = () =>
    state.viewportZoom > 1.001 || state.viewportZoom < 0.999;
  const viewportZoomPercent = () => getViewportZoomPercent();
  const zoomIndicatorPositionClass = () => "right-4 top-4";

  const activeMask = (): MaskParamsInfo | null => draftMask() ?? selectedMaskParams();
  const selectedArtboard = () => getSelectedArtboard();

  async function applyCropAspectRatioPreset(preset: CropAspectRatioPreset) {
    setCropAspectRatioPreset(preset);
    const cropLayer = selectedCropLayer();
    const crop = activeCrop();
    if (!cropLayer || !crop) {
      return;
    }
    const ratio = resolveCropAspectRatio(preset, state.canvasWidth, state.canvasHeight);
    if (!ratio) {
      return;
    }
    const nextCrop = fitCropRectToAspectRatio(
      crop,
      ratio,
      state.canvasWidth,
      state.canvasHeight,
    );
    setDraftCrop(nextCrop);
    await applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "crop",
      crop_x: nextCrop.x,
      crop_y: nextCrop.y,
      crop_width: nextCrop.width,
      crop_height: nextCrop.height,
      crop_rotation: nextCrop.rotation,
    });
  }

  const brushCursorStyle = createMemo((): string | undefined => {
    if (activeMask()?.kind !== "brush") return undefined;
    const sw = state.viewportScreenWidth;
    const sh = state.viewportScreenHeight;
    const cw = state.canvasWidth;
    const ch = state.canvasHeight;
    if (sw <= 0 || sh <= 0 || cw <= 0 || ch <= 0) return "none";
    const fitScale = Math.min(sw / cw, sh / ch) * state.viewportZoom;
    return makeBrushCursor(brushSize(), fitScale);
  });

  async function initBrushOverlay() {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    if (w === 0 || h === 0) return;
    const scale = Math.min(1, BRUSH_OVERLAY_MAX / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    brushOverlayCanvas = canvas;
    brushOverlayPixels = new Uint8Array(tw * th);
    // Populate with current mask state
    const layerIdx = state.selectedLayerIdx;
    if (state.layers[layerIdx]?.has_mask) {
      try {
        const thumb = await getMaskThumbnail(layerIdx, BRUSH_OVERLAY_MAX, BRUSH_OVERLAY_MAX);
        brushOverlayPixels = new Uint8Array(thumb.pixels);
        redrawOverlayCanvas();
      } catch {
        // mask has no data yet
      }
    }
    drawFrame();
  }

  function redrawOverlayCanvas() {
    if (!brushOverlayCanvas || !brushOverlayPixels) return;
    const ctx = brushOverlayCanvas.getContext("2d");
    if (!ctx) return;
    const tw = brushOverlayCanvas.width;
    const th = brushOverlayCanvas.height;
    const imgData = ctx.createImageData(tw, th);
    for (let i = 0; i < brushOverlayPixels.length; i++) {
      imgData.data[i * 4 + 0] = 220;
      imgData.data[i * 4 + 1] = 30;
      imgData.data[i * 4 + 2] = 30;
      imgData.data[i * 4 + 3] = Math.round(brushOverlayPixels[i] * 0.65);
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function stampBrushOverlay(imageX: number, imageY: number, radius: number, softness: number, erase: boolean) {
    if (!brushOverlayCanvas || !brushOverlayPixels) return;
    const tw = brushOverlayCanvas.width;
    const th = brushOverlayCanvas.height;
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
          brushOverlayPixels[idx] = Math.min(brushOverlayPixels[idx], floor);
        } else {
          brushOverlayPixels[idx] = Math.max(brushOverlayPixels[idx], Math.round(alpha * 255));
        }
      }
    }
    redrawOverlayCanvas();
  }
  const selectedArtboardRating = () => selectedArtboard()?.activeMediaRating ?? null;

  async function handleSetRating(rating: number | null) {
    const artboard = selectedArtboard();
    const mediaId = mediaRatingIdForArtboard(artboard);
    if (!artboard || !mediaId || isSavingRating()) {
      return;
    }
    const nextRating = rating ?? artboard.activeMediaBaseRating;
    const previousRating = artboard.activeMediaRating;
    setState(
      "artboards",
      (candidate) => candidate.id === artboard.id,
      "activeMediaRating",
      nextRating,
    );
    setIsSavingRating(true);
    try {
      await setMediaRating({
        media_id: mediaId,
        rating,
      });
    } catch (error) {
      setState(
        "artboards",
        (candidate) => candidate.id === artboard.id,
        "activeMediaRating",
        previousRating,
      );
      setState("loadError", error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingRating(false);
    }
  }

  function handleViewportArtboardActionError(error: unknown) {
    if (isMissingArtboardError(error)) {
      return;
    }
    setState("loadError", error instanceof Error ? error.message : String(error));
  }

  function requestArtboardSelection(artboardId: string) {
    void selectArtboard(artboardId).catch(handleViewportArtboardActionError);
  }

  function requestArtboardClose(artboardId: string) {
    void closeArtboard(artboardId).catch(handleViewportArtboardActionError);
  }

  // Build the camera for the current viewport state
  function getCamera() {
    return {
      centerX: state.viewportCenterX,
      centerY: state.viewportCenterY,
      zoom: state.viewportZoom,
    };
  }

  function getViewWorldOffset() {
    const artboard = getSelectedArtboard();
    return artboard ? { x: artboard.worldX, y: artboard.worldY } : { x: 0, y: 0 };
  }

  function toWorldX(localX: number) {
    return localX + getViewWorldOffset().x;
  }

  function toWorldY(localY: number) {
    return localY + getViewWorldOffset().y;
  }

  // Transform for normal viewing and mask overlays (fits to crop rect or full canvas in crop mode)
  function getViewTransform(cssWidth: number, cssHeight: number): WorldTransform {
    const offset = getViewWorldOffset();
    const fit = getViewportFitRef();
    return buildTransform(
      {
        centerX: state.viewportCenterX + offset.x,
        centerY: state.viewportCenterY + offset.y,
        zoom: state.viewportZoom,
      },
      { width: cssWidth, height: cssHeight },
      {
        x: fit.x + offset.x,
        y: fit.y + offset.y,
        width: fit.width,
        height: fit.height,
      },
    );
  }

  // Transform for crop-edit overlays (always fits to full canvas)
  function getCropEditTransform(cssWidth: number, cssHeight: number): WorldTransform {
    const offset = getViewWorldOffset();
    return buildTransform(
      {
        centerX: state.viewportCenterX + offset.x,
        centerY: state.viewportCenterY + offset.y,
        zoom: state.viewportZoom,
      },
      { width: cssWidth, height: cssHeight },
      {
        x: offset.x,
        y: offset.y,
        width: state.canvasWidth,
        height: state.canvasHeight,
      },
    );
  }

  function stopToneSmoothing() {
    if (toneSmoothingFrame === null) {
      return;
    }
    cancelAnimationFrame(toneSmoothingFrame);
    toneSmoothingFrame = null;
  }

  function updateSmoothedToneSample(nextTarget: number | null) {
    targetToneSample = nextTarget;
    if (nextTarget === null) {
      stopToneSmoothing();
      smoothedToneSample = null;
      lastToneSampleTime = 0;
      setViewportToneSample(null);
      return;
    }
    if (smoothedToneSample === null) {
      smoothedToneSample = nextTarget;
      lastToneSampleTime = performance.now();
      setViewportToneSample(nextTarget);
      return;
    }
    if (toneSmoothingFrame !== null) {
      return;
    }
    const tick = (time: number) => {
      if (targetToneSample === null || smoothedToneSample === null) {
        stopToneSmoothing();
        return;
      }
      const deltaMs = Math.max(1, time - lastToneSampleTime);
      lastToneSampleTime = time;
      const blend = 1 - Math.exp(-deltaMs / 90);
      smoothedToneSample += (targetToneSample - smoothedToneSample) * blend;
      if (Math.abs(targetToneSample - smoothedToneSample) < 0.002) {
        smoothedToneSample = targetToneSample;
      }
      setViewportToneSample(smoothedToneSample);
      if (smoothedToneSample === targetToneSample) {
        toneSmoothingFrame = null;
        return;
      }
      toneSmoothingFrame = requestAnimationFrame(tick);
    };
    lastToneSampleTime = performance.now();
    toneSmoothingFrame = requestAnimationFrame(tick);
  }

  function sampleTileTone(tile: { image: ImageData; x: number; y: number; width: number; height: number } | null, x: number, y: number) {
    if (!tile) {
      return null;
    }
    if (x < tile.x || y < tile.y || x >= tile.x + tile.width || y >= tile.y + tile.height) {
      return null;
    }
    const imageX = clamp(
      Math.floor(((x - tile.x) / tile.width) * tile.image.width),
      0,
      tile.image.width - 1,
    );
    const imageY = clamp(
      Math.floor(((y - tile.y) / tile.height) * tile.image.height),
      0,
      tile.image.height - 1,
    );
    const pixelData = tile.image.data as ArrayLike<number>;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let count = 0;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const sampleY = clamp(imageY + offsetY, 0, tile.image.height - 1);
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const sampleX = clamp(imageX + offsetX, 0, tile.image.width - 1);
        const index = (sampleY * tile.image.width + sampleX) * 4;
        red += pixelData[index];
        green += pixelData[index + 1];
        blue += pixelData[index + 2];
        alpha += pixelData[index + 3];
        count += 1;
      }
    }
    if (count <= 0) {
      throw new Error("tile tone sampling requires at least one sample");
    }
    const normalize = tile.image.data instanceof Uint8ClampedArray ? 255 : 1;
    const averageAlpha = (alpha / count) / normalize;
    if (averageAlpha <= 0) {
      return null;
    }
    const averageRed = (red / count) / normalize;
    const averageGreen = (green / count) / normalize;
    const averageBlue = (blue / count) / normalize;
    return (
      (averageRed * 0.2126 + averageGreen * 0.7152 + averageBlue * 0.0722) * averageAlpha
    );
  }

  function updateViewportToneFromPointer(clientX: number, clientY: number) {
    if (!stageRef) {
      updateSmoothedToneSample(null);
      return;
    }
    const artboard = getSelectedArtboard();
    if (!artboard) {
      updateSmoothedToneSample(null);
      return;
    }
    const rect = stageRef.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const transform = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
    if (transform.scale <= 0) {
      updateSmoothedToneSample(null);
      return;
    }
    let sampleX = cssX;
    let sampleY = cssY;
    const cropLayer = selectedCropLayer();
    const committedCrop = cropLayer ? null : getCommittedCropRect();
    if (committedCrop && committedCrop.rotation !== 0) {
      const cropCenter = worldToScreen(
        toWorldX(committedCrop.x + committedCrop.width * 0.5),
        toWorldY(committedCrop.y + committedCrop.height * 0.5),
        transform,
      );
      const unrotated = rotatePoint(sampleX, sampleY, cropCenter.x, cropCenter.y, committedCrop.rotation);
      sampleX = unrotated.x;
      sampleY = unrotated.y;
    }
    const world = screenToWorld(sampleX, sampleY, transform);
    const localX = world.x - artboard.worldX;
    const localY = world.y - artboard.worldY;
    if (localX < 0 || localY < 0 || localX >= artboard.width || localY >= artboard.height) {
      updateSmoothedToneSample(null);
      return;
    }
    if (
      committedCrop &&
      (localX < committedCrop.x ||
        localY < committedCrop.y ||
        localX >= committedCrop.x + committedCrop.width ||
        localY >= committedCrop.y + committedCrop.height)
    ) {
      updateSmoothedToneSample(null);
      return;
    }
    const visiblePreview = cropLayer ? null : previewTile() ?? artboard.previewTile;
    const visibleBackdrop = backdropTile() ?? artboard.backdropTile;
    const tone =
      sampleTileTone(visiblePreview, localX, localY) ??
      sampleTileTone(visibleBackdrop, localX, localY);
    updateSmoothedToneSample(tone);
  }

  function maskHandleAtPoint(sx: number, sy: number): MaskHandle | null {
    if (!stageRef) return null;
    const mp = activeMask();
    // Brush masks don't have drag handles
    if (!mp || mp.kind === "brush") return null;
    const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
    if (t.scale <= 0) return null;

    const toScreen = (ax: number, ay: number) => worldToScreen(toWorldX(ax), toWorldY(ay), t);
    const GRAB_R = 14;

    if (mp.kind === "linear") {
      const s = toScreen(mp.x1 ?? 0, mp.y1 ?? 0);
      const e = toScreen(mp.x2 ?? 0, mp.y2 ?? 0);
      if (Math.hypot(sx - s.x, sy - s.y) <= GRAB_R) return "start";
      if (Math.hypot(sx - e.x, sy - e.y) <= GRAB_R) return "end";
    } else {
      const c = toScreen(mp.cx ?? 0, mp.cy ?? 0);
      const edgeX = (mp.cx ?? 0) + (mp.radius ?? 0);
      const edgeY = mp.cy ?? 0;
      const e = toScreen(edgeX, edgeY);
      if (Math.hypot(sx - e.x, sy - e.y) <= GRAB_R) return "edge";
      if (Math.hypot(sx - c.x, sy - c.y) <= GRAB_R) return "center";
    }
    return null;
  }

  function drawMaskOverlay(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
  ) {
    const mp = activeMask();
    if (!mp) return;
    const t = getViewTransform(cssWidth, cssHeight);
    if (t.scale <= 0) return;

    const toScreen = (ax: number, ay: number) => worldToScreen(toWorldX(ax), toWorldY(ay), t);

    ctx.save();

    const drawHandle = (x: number, y: number, filled: boolean) => {
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      if (filled) {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      } else {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    if (mp.kind === "brush") {
      if (brushOverlayCanvas) {
        const tl = worldToScreen(toWorldX(0), toWorldY(0), t);
        const br = worldToScreen(toWorldX(state.canvasWidth), toWorldY(state.canvasHeight), t);
        ctx.drawImage(brushOverlayCanvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      }
      ctx.restore();
      return;
    }

    if (mp.kind === "linear") {
      const s = toScreen(mp.x1 ?? 0, mp.y1 ?? 0);
      const e = toScreen(mp.x2 ?? 0, mp.y2 ?? 0);

      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      ctx.setLineDash([]);

      drawHandle(s.x, s.y, false);
      drawHandle(e.x, e.y, true);
    } else {
      const c = toScreen(mp.cx ?? 0, mp.cy ?? 0);
      const r = (mp.radius ?? 0) * t.scale;

      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      drawHandle(c.x, c.y, true);

      const edgeX = (mp.cx ?? 0) + (mp.radius ?? 0);
      const edgeY = mp.cy ?? 0;
      const e = toScreen(edgeX, edgeY);
      drawHandle(e.x, e.y, false);
    }
    ctx.restore();
  }

  function cropHandleAtPoint(x: number, y: number) {
    if (!stageRef || !selectedCropLayer()) return null;
    const t = getCropEditTransform(stageRef.clientWidth, stageRef.clientHeight);
    if (t.scale <= 0) return null;
    const draft = activeCrop();
    if (!draft) return null;
    const center = worldToScreen(
      toWorldX(draft.x + draft.width * 0.5),
      toWorldY(draft.y + draft.height * 0.5),
      t,
    );
    const cx = center.x;
    const cy = center.y;
    const cos = Math.cos(-draft.rotation);
    const sin = Math.sin(-draft.rotation);
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * cos - dy * sin + cx;
    const ly = dx * sin + dy * cos + cy;
    // Rotation handle: 30px above top-center in screen space
    const rotHandleScreenY = cy - (draft.height * 0.5) * t.scale - 30;
    const rhDx = 0;
    const rhDy = rotHandleScreenY - cy;
    const rhScreenX = cx + rhDx * Math.cos(draft.rotation) - rhDy * Math.sin(draft.rotation);
    const rhScreenY = cy + rhDx * Math.sin(draft.rotation) + rhDy * Math.cos(draft.rotation);
    if (Math.hypot(x - rhScreenX, y - rhScreenY) <= HANDLE_SIZE + 4) return "rotate" as CropHandle;
    const { x: left, y: top } = worldToScreen(toWorldX(draft.x), toWorldY(draft.y), t);
    const { x: right, y: bottom } = worldToScreen(
      toWorldX(draft.x + draft.width),
      toWorldY(draft.y + draft.height),
      t,
    );
    const nearLeft = Math.abs(lx - left) <= HANDLE_SIZE;
    const nearRight = Math.abs(lx - right) <= HANDLE_SIZE;
    const nearTop = Math.abs(ly - top) <= HANDLE_SIZE;
    const nearBottom = Math.abs(ly - bottom) <= HANDLE_SIZE;
    const inside = lx >= left && lx <= right && ly >= top && ly <= bottom;
    if (nearLeft && nearTop) return "top-left";
    if (nearRight && nearTop) return "top-right";
    if (nearRight && nearBottom) return "bottom-right";
    if (nearLeft && nearBottom) return "bottom-left";
    if (nearTop && inside) return "top";
    if (nearRight && inside) return "right";
    if (nearBottom && inside) return "bottom";
    if (nearLeft && inside) return "left";
    if (inside) return "move";
    return null;
  }

  function drawCropOverlay(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
  ) {
    if (!selectedCropLayer()) return;
    const t = getCropEditTransform(cssWidth, cssHeight);
    if (t.scale <= 0) return;
    const draft = activeCrop();
    if (!draft) return;
    const width = draft.width * t.scale;
    const height = draft.height * t.scale;
    const center = worldToScreen(
      toWorldX(draft.x + draft.width * 0.5),
      toWorldY(draft.y + draft.height * 0.5),
      t,
    );
    const cx = center.x;
    const cy = center.y;
    ctx.save();
    // Dimmed overlay with rotated cutout
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, cssWidth, cssHeight);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(draft.rotation);
    ctx.rect(-width / 2, -height / 2, width, height);
    ctx.restore();
    ctx.fill("evenodd");
    // Draw crop rect and grid in rotated space
    ctx.translate(cx, cy);
    ctx.rotate(draft.rotation);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-width / 2, -height / 2, width, height);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.beginPath();
    ctx.moveTo(-width / 2 + width / 3, -height / 2);
    ctx.lineTo(-width / 2 + width / 3, height / 2);
    ctx.moveTo(-width / 2 + (width * 2) / 3, -height / 2);
    ctx.lineTo(-width / 2 + (width * 2) / 3, height / 2);
    ctx.moveTo(-width / 2, -height / 2 + height / 3);
    ctx.lineTo(width / 2, -height / 2 + height / 3);
    ctx.moveTo(-width / 2, -height / 2 + (height * 2) / 3);
    ctx.lineTo(width / 2, -height / 2 + (height * 2) / 3);
    ctx.stroke();
    // Corner and edge handles
    ctx.fillStyle = "#ffffff";
    for (const [hx, hy] of [
      [-width / 2, -height / 2],
      [0, -height / 2],
      [width / 2, -height / 2],
      [width / 2, 0],
      [width / 2, height / 2],
      [0, height / 2],
      [-width / 2, height / 2],
      [-width / 2, 0],
    ]) {
      ctx.fillRect(hx - 3, hy - 3, 6, 6);
    }
    // Rotation handle: circle above top-center
    ctx.beginPath();
    ctx.arc(0, -height / 2 - 30, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.beginPath();
    ctx.moveTo(0, -height / 2);
    ctx.lineTo(0, -height / 2 - 25);
    ctx.stroke();
    ctx.restore();
  }

  function getArtboardPlaceholderFill(isLoading: boolean) {
    if (!containerRef) {
      return isLoading ? "rgba(128, 128, 128, 0.32)" : "rgba(128, 128, 128, 0.18)";
    }
    const styles = getComputedStyle(containerRef);
    const fill = styles
      .getPropertyValue(isLoading ? "--surface-active" : "--surface")
      .trim();
    return fill || (isLoading ? "rgba(128, 128, 128, 0.32)" : "rgba(128, 128, 128, 0.18)");
  }

  function drawLoadingImageOnArtboard(
    ctx: CanvasRenderingContext2D,
    artboard: ArtboardState,
    t: WorldTransform,
  ) {
    const image = loadingArtboardImage();
    if (!image) {
      return;
    }
    const screenX = artboard.worldX * t.scale + t.dx;
    const screenY = artboard.worldY * t.scale + t.dy;
    const screenWidth = artboard.width * t.scale;
    const screenHeight = artboard.height * t.scale;
    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }
    const scale = Math.min(screenWidth / image.naturalWidth, screenHeight / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const drawX = screenX + (screenWidth - drawWidth) * 0.5;
    const drawY = screenY + (screenHeight - drawHeight) * 0.5;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  }

  function drawFrame() {
    if (!canvasRef || !containerRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    const cssWidth = Math.max(1, Math.floor(containerRef.clientWidth));
    const cssHeight = Math.max(1, Math.floor(containerRef.clientHeight));
    const devicePixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio));
    if (canvasRef.width !== pixelWidth || canvasRef.height !== pixelHeight) {
      canvasRef.width = pixelWidth;
      canvasRef.height = pixelHeight;
    }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const selectedArtboard = getSelectedArtboard();
    if (selectedArtboard) {
      const t = getViewTransform(cssWidth, cssHeight);
      const visibleArtboardIds = state.artboards
        .filter((artboard) => {
          const sx = artboard.worldX * t.scale + t.dx;
          const sy = artboard.worldY * t.scale + t.dy;
          const sw = artboard.width * t.scale;
          const sh = artboard.height * t.scale;
          return sx + sw > 0 && sy + sh > 0 && sx < cssWidth && sy < cssHeight;
        })
        .map((artboard) => artboard.id);
      for (const artboard of state.artboards) {
        const worldArtboard = {
          worldX: artboard.worldX,
          worldY: artboard.worldY,
          width: artboard.width,
          height: artboard.height,
        };
        const isSelected = artboard.id === selectedArtboard.id;
        const shouldFadeChrome =
          visibleArtboardIds.length === 1 && visibleArtboardIds[0] === artboard.id;
        const cropLayer = isSelected ? selectedCropLayer() : null;
        const committedCrop = isSelected ? getCommittedCropRect() : null;
        const clip = cropLayer || !committedCrop ? undefined : committedCrop;
        const visibleBackdrop = isSelected ? backdropTile() ?? artboard.backdropTile : artboard.backdropTile;
        const visiblePreview =
          isSelected && !cropLayer ? previewTile() ?? artboard.previewTile : null;
        const sx = worldArtboard.worldX * t.scale + t.dx;
        const sy = worldArtboard.worldY * t.scale + t.dy;
        const sw = worldArtboard.width * t.scale;
        const sh = worldArtboard.height * t.scale;
        if (!visibleBackdrop && !visiblePreview) {
          ctx.fillStyle = getArtboardPlaceholderFill(isSelected && state.isLoading);
          ctx.fillRect(sx, sy, sw, sh);
          if (isSelected && state.isLoading && state.loadingMediaSrc) {
            drawLoadingImageOnArtboard(ctx, artboard, t);
          }
        }
        compositeArtboard(
          ctx,
          worldArtboard,
          visibleBackdrop,
          visiblePreview,
          t,
          clip,
        );
        ctx.save();
        ctx.globalAlpha = shouldFadeChrome ? ARTBOARD_CHROME_FADE : 1;
        ctx.strokeStyle = "rgba(148, 148, 148, 0.7)";
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        const measured = ctx.measureText(artboard.title);
        const labelWidth = Math.min(
          ARTBOARD_TITLE_MAX_WIDTH,
          measured.width + ARTBOARD_TITLE_PADDING_X * 2,
        );
        const labelX = sx;
        const labelY = sy - ARTBOARD_TITLE_HEIGHT - 6;
        const pressedChrome = pressedArtboardChrome();
        const titlePressed =
          pressedChrome?.kind === "title" && pressedChrome.artboardId === artboard.id;
        const closePressed =
          pressedChrome?.kind === "close" && pressedChrome.artboardId === artboard.id;
        ctx.fillStyle = titlePressed
          ? "rgba(214, 214, 214, 0.98)"
          : isSelected
            ? "rgba(255, 255, 255, 0.95)"
            : "rgba(148, 148, 148, 0.78)";
        ctx.fillRect(labelX, labelY, labelWidth, ARTBOARD_TITLE_HEIGHT);
        ctx.fillStyle = titlePressed ? "rgba(12, 12, 12, 0.98)" : "rgba(32, 32, 32, 0.95)";
        ctx.textBaseline = "middle";
        ctx.fillText(
          artboard.title,
          labelX + ARTBOARD_TITLE_PADDING_X,
          labelY + ARTBOARD_TITLE_HEIGHT * 0.5,
          labelWidth - ARTBOARD_TITLE_PADDING_X * 2,
        );
        const closeX = sx + sw - ARTBOARD_CLOSE_SIZE;
        const closeY = labelY;
        ctx.fillStyle = closePressed
          ? "rgba(214, 214, 214, 0.98)"
          : "rgba(148, 148, 148, 0.82)";
        ctx.fillRect(closeX, closeY, ARTBOARD_CLOSE_SIZE, ARTBOARD_CLOSE_SIZE);
        ctx.strokeStyle = closePressed ? "rgba(12, 12, 12, 0.98)" : "rgba(32, 32, 32, 0.95)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(closeX + 5, closeY + 5);
        ctx.lineTo(closeX + ARTBOARD_CLOSE_SIZE - 5, closeY + ARTBOARD_CLOSE_SIZE - 5);
        ctx.moveTo(closeX + ARTBOARD_CLOSE_SIZE - 5, closeY + 5);
        ctx.lineTo(closeX + 5, closeY + ARTBOARD_CLOSE_SIZE - 5);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawCropOverlay(ctx, cssWidth, cssHeight);
    drawMaskOverlay(ctx, cssWidth, cssHeight);
  }

  createEffect(() => {
    state.viewportScreenWidth;
    state.viewportScreenHeight;
    state.viewportZoom;
    state.viewportCenterX;
    state.viewportCenterY;
    state.selectedLayerIdx;
    state.selectedArtboardId;
    state.layers;
    state.artboards;
    state.loadingMediaSrc;
    pressedArtboardChrome();
    backdropTile();
    previewTile();
    loadingArtboardImage();
    drawFrame();
  });

  // Initialize / clear brush overlay when brush mask mode changes
  createEffect(() => {
    const isBrush = activeMask()?.kind === "brush";
    if (!isBrush) {
      brushOverlayCanvas = null;
      brushOverlayPixels = null;
      return;
    }
    void initBrushOverlay();
  });

  createEffect(() => {
    const src = state.loadingMediaSrc;
    if (!src) {
      setLoadingArtboardImage(null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!cancelled) {
        setLoadingArtboardImage(image);
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setLoadingArtboardImage(null);
      }
    };
    image.src = src;
    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const cropLayer = selectedCropLayer();
    setDraftCrop(cropLayer?.crop ?? null);
  });

  onMount(() => {
    const container = containerRef;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportScreenSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!state.webgpuAvailable) {
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    try {
      for (const [index, file] of files.entries()) {
        await openImageFile(file, index === 0 ? "replace" : "append");
      }
    } catch {
      return;
    }
  };

  function artboardAtPoint(sx: number, sy: number): ArtboardState | null {
    if (!stageRef) return null;
    const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
    for (let idx = state.artboards.length - 1; idx >= 0; idx -= 1) {
      const artboard = state.artboards[idx];
      const x = artboard.worldX * t.scale + t.dx;
      const y = artboard.worldY * t.scale + t.dy;
      const width = artboard.width * t.scale;
      const height = artboard.height * t.scale;
      if (sx >= x && sx <= x + width && sy >= y && sy <= y + height) {
        return artboard;
      }
    }
    return null;
  }

  function artboardTitleAtPoint(sx: number, sy: number): ArtboardState | null {
    if (!stageRef) return null;
    const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
    const scratch = document.createElement("canvas");
    const ctx = scratch.getContext("2d");
    if (!ctx) {
      throw new Error("2d canvas context required for artboard title hit testing");
    }
    ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let idx = state.artboards.length - 1; idx >= 0; idx -= 1) {
      const artboard = state.artboards[idx];
      const x = artboard.worldX * t.scale + t.dx;
      const y = artboard.worldY * t.scale + t.dy;
      const width = Math.min(
        ARTBOARD_TITLE_MAX_WIDTH,
        ctx.measureText(artboard.title).width + ARTBOARD_TITLE_PADDING_X * 2,
      );
      const titleY = y - ARTBOARD_TITLE_HEIGHT - 6;
      if (sx >= x && sx <= x + width && sy >= titleY && sy <= titleY + ARTBOARD_TITLE_HEIGHT) {
        return artboard;
      }
    }
    return null;
  }

  function artboardCloseAtPoint(sx: number, sy: number): ArtboardState | null {
    if (!stageRef) return null;
    const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
    for (let idx = state.artboards.length - 1; idx >= 0; idx -= 1) {
      const artboard = state.artboards[idx];
      const x = artboard.worldX * t.scale + t.dx + artboard.width * t.scale - ARTBOARD_CLOSE_SIZE;
      const y = artboard.worldY * t.scale + t.dy - ARTBOARD_TITLE_HEIGHT - 6;
      if (
        sx >= x &&
        sx <= x + ARTBOARD_CLOSE_SIZE &&
        sy >= y &&
        sy <= y + ARTBOARD_CLOSE_SIZE
      ) {
        return artboard;
      }
    }
    return null;
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!stageRef) {
      throw new Error("viewport stage is required for wheel zoom");
    }
    const deltaModeScale =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (stageRef?.clientHeight ?? 1)
          : 1;
    const delta = e.deltaY * deltaModeScale;
    const rect = stageRef.getBoundingClientRect();
    zoomViewport(delta, e.ctrlKey, e.clientX - rect.left, e.clientY - rect.top);
    lastStagePointer = { x: e.clientX, y: e.clientY };
    updateViewportToneFromPointer(e.clientX, e.clientY);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!stageRef) {
      throw new Error("viewport stage is required for pointer interaction");
    }
    const rect = stageRef.getBoundingClientRect();
    const clickedArtboardClose = artboardCloseAtPoint(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    if (e.button === 0 && clickedArtboardClose) {
      setPressedArtboardChrome({
        kind: "close",
        artboardId: clickedArtboardClose.id,
      });
      return;
    }
    const clickedArtboardTitle =
      e.button === 0
        ? artboardTitleAtPoint(e.clientX - rect.left, e.clientY - rect.top)
        : null;
    const clickedArtboard = artboardAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    lastStagePointer = { x: e.clientX, y: e.clientY };
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (selectedCropLayer() && e.button === 0) {
      const handle = cropHandleAtPoint(e.clientX - rect.left, e.clientY - rect.top);
      if (!handle) return;
      const crop = activeCrop();
      if (!crop) {
        throw new Error("crop interaction requires a crop layer");
      }
      gesture = {
        kind: "crop",
        pointerId: e.pointerId,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        crop,
      };
      stageRef.setPointerCapture(e.pointerId);
      drawFrame();
      return;
    }
    if (activeMask()?.kind === "brush" && e.button === 0) {
      const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
      if (t.scale > 0) {
        const rect = stageRef.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = screenToWorld(sx, sy, t);
        const imgX = world.x - getViewWorldOffset().x;
        const imgY = world.y - getViewWorldOffset().y;
        const erase = e.altKey;
        stampBrushOverlay(imgX, imgY, brushSize(), brushSoftness(), erase);
        void stampBrushMask(state.selectedLayerIdx, imgX, imgY, brushSize(), brushSoftness(), erase);
        gesture = { kind: "brush_paint", pointerId: e.pointerId, lastImgX: imgX, lastImgY: imgY, erase };
        stageRef.setPointerCapture(e.pointerId);
        drawFrame();
        return;
      }
    }
    if (activeMask()) {
      const rect = stageRef.getBoundingClientRect();
      const handle = maskHandleAtPoint(e.clientX - rect.left, e.clientY - rect.top);
      if (handle) {
        const params = activeMask()!;
        gesture = {
          kind: "mask",
          pointerId: e.pointerId,
          handle,
          startX: e.clientX,
          startY: e.clientY,
          params: { ...params },
        };
        stageRef.setPointerCapture(e.pointerId);
        drawFrame();
        return;
      }
    }
    if (activePointers.size === 2) {
      if (
        gesture?.kind === "artboard" &&
        stageRef.hasPointerCapture(gesture.pointerId)
      ) {
        stageRef.releasePointerCapture(gesture.pointerId);
      }
      const [p1, p2] = [...activePointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      gesture = { kind: "pinch", dist, midX, midY };
      return;
    }
    if (clickedArtboardTitle) {
      setPressedArtboardChrome({
        kind: "title",
        artboardId: clickedArtboardTitle.id,
      });
      gesture = {
        kind: "artboard",
        pointerId: e.pointerId,
        artboardId: clickedArtboardTitle.id,
        draggable: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
      };
      stageRef.setPointerCapture(e.pointerId);
      return;
    }
    if (clickedArtboard) {
      setPressedArtboardChrome(null);
      gesture = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        tapArtboardId: e.button === 0 ? clickedArtboard.id : null,
      };
      return;
    }
    setPressedArtboardChrome(null);
    gesture = {
      kind: "pan",
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      tapArtboardId: null,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!stageRef) return;
    lastStagePointer = { x: e.clientX, y: e.clientY };
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    updateViewportToneFromPointer(e.clientX, e.clientY);
    if (!gesture) return;
    if (gesture.kind === "brush_paint") {
      const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
      if (t.scale <= 0) return;
      const rect = stageRef.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, t);
      const imgX = world.x - getViewWorldOffset().x;
      const imgY = world.y - getViewWorldOffset().y;
      // Interpolate stamps along the path to avoid gaps at high speed
      const dist = Math.hypot(imgX - gesture.lastImgX, imgY - gesture.lastImgY);
      const spacing = Math.max(1, brushSize() * 0.3);
      if (dist >= spacing) {
        const steps = Math.floor(dist / spacing);
        const { erase } = gesture;
        for (let i = 1; i <= steps; i++) {
          const f = i / steps;
          const ix = gesture.lastImgX + (imgX - gesture.lastImgX) * f;
          const iy = gesture.lastImgY + (imgY - gesture.lastImgY) * f;
          stampBrushOverlay(ix, iy, brushSize(), brushSoftness(), erase);
          void stampBrushMask(state.selectedLayerIdx, ix, iy, brushSize(), brushSoftness(), erase);
        }
        gesture = { kind: "brush_paint", pointerId: gesture.pointerId, lastImgX: imgX, lastImgY: imgY, erase };
      }
      drawFrame();
      return;
    }
    if (gesture.kind === "pan") {
      const movedX = e.clientX - gesture.startX;
      const movedY = e.clientY - gesture.startY;
      const didCrossThreshold =
        Math.hypot(movedX, movedY) >= ARTBOARD_DRAG_THRESHOLD;
      if (gesture.tapArtboardId && !gesture.moved && !didCrossThreshold) {
        return;
      }
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      panViewport(dx, dy, false);
      drawFrame();
      gesture = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        startX: gesture.startX,
        startY: gesture.startY,
        moved: gesture.moved || didCrossThreshold,
        tapArtboardId: gesture.tapArtboardId,
      };
      return;
    }
    if (gesture.kind === "artboard") {
      if (!gesture.draggable) {
        return;
      }
      const movedX = e.clientX - gesture.startX;
      const movedY = e.clientY - gesture.startY;
      const didCrossThreshold =
        Math.hypot(movedX, movedY) >= ARTBOARD_DRAG_THRESHOLD;
      if (!gesture.moved && !didCrossThreshold) {
        return;
      }
      if (!gesture.moved) {
        setPressedArtboardChrome(null);
      }
      const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
      if (t.scale <= 0) return;
      const deltaX = (e.clientX - gesture.x) / t.scale;
      const deltaY = (e.clientY - gesture.y) / t.scale;
      moveArtboardBy(gesture.artboardId, deltaX, deltaY);
      if (gesture.artboardId === state.selectedArtboardId) {
        offsetViewportCenter(-deltaX, -deltaY);
      }
      drawFrame();
      gesture = {
        kind: "artboard",
        pointerId: gesture.pointerId,
        artboardId: gesture.artboardId,
        draggable: gesture.draggable,
        moved: true,
        startX: gesture.startX,
        startY: gesture.startY,
        x: e.clientX,
        y: e.clientY,
      };
      return;
    }
    if (gesture.kind === "pinch") {
      if (activePointers.size >= 2) {
        const [p1, p2] = [...activePointers.values()];
        const newDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const newMidX = (p1.x + p2.x) / 2;
        const newMidY = (p1.y + p2.y) / 2;
        const rect = stageRef.getBoundingClientRect();
        const delta = -Math.log(newDist / gesture.dist) / 0.0005;
        zoomViewport(delta, true, newMidX - rect.left, newMidY - rect.top);
        panViewport(newMidX - gesture.midX, newMidY - gesture.midY, false);
        gesture = { kind: "pinch", dist: newDist, midX: newMidX, midY: newMidY };
        drawFrame();
      }
      return;
    }
    if (gesture.kind === "mask") {
      const t = getViewTransform(stageRef.clientWidth, stageRef.clientHeight);
      if (t.scale <= 0) return;
      const dx = (e.clientX - gesture.startX) / t.scale;
      const dy = (e.clientY - gesture.startY) / t.scale;
      const p = gesture.params;
      let next: MaskParamsInfo;
      if (p.kind === "linear") {
        const sx = p.x1 ?? 0,
          sy = p.y1 ?? 0,
          ex = p.x2 ?? 0,
          ey = p.y2 ?? 0;
        if (gesture.handle === "start") {
          next = { ...p, x1: sx + dx, y1: sy + dy };
        } else {
          next = { ...p, x2: ex + dx, y2: ey + dy };
        }
      } else {
        const cx = p.cx ?? 0,
          cy = p.cy ?? 0,
          r = p.radius ?? 0;
        if (gesture.handle === "center") {
          next = { ...p, cx: cx + dx, cy: cy + dy };
        } else {
          const newEdgeX = cx + r + dx;
          const newEdgeY = cy + dy;
          const newR = Math.max(1, Math.hypot(newEdgeX - cx, newEdgeY - cy));
          next = { ...p, radius: newR };
        }
      }
      setDraftMask(next);
      drawFrame();
      return;
    }
    // Crop handle drag
    const t = getCropEditTransform(stageRef.clientWidth, stageRef.clientHeight);
    if (t.scale <= 0) {
      throw new Error("crop mode requires visible image bounds");
    }
    const start = gesture.crop;
    if (gesture.handle === "rotate") {
      const center = worldToScreen(
        toWorldX(start.x + start.width * 0.5),
        toWorldY(start.y + start.height * 0.5),
        t,
      );
      const rect = stageRef.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const rawAngle = Math.atan2(mx - center.x, -(my - center.y));
      const angle = e.shiftKey
        ? Math.round(rawAngle / CROP_ROTATION_SNAP_STEP) * CROP_ROTATION_SNAP_STEP
        : rawAngle;
      setDraftCrop({ ...start, rotation: angle });
      drawFrame();
      return;
    }
    const rawDx = (e.clientX - gesture.startX) / t.scale;
    const rawDy = (e.clientY - gesture.startY) / t.scale;
    const cos = Math.cos(-start.rotation);
    const sin = Math.sin(-start.rotation);
    const deltaX = rawDx * cos - rawDy * sin;
    const deltaY = rawDx * sin + rawDy * cos;
    let next = start;
    const aspectRatio = selectedCropAspectRatio();
    if (gesture.handle === "move") {
      next = {
        ...start,
        x: Math.min(Math.max(0, start.x + rawDx), state.canvasWidth - start.width),
        y: Math.min(Math.max(0, start.y + rawDy), state.canvasHeight - start.height),
      };
    } else if (aspectRatio) {
      next = constrainCropDragToAspectRatio(
        start,
        gesture.handle as CropResizeHandle,
        deltaX,
        deltaY,
        aspectRatio,
        state.canvasWidth,
        state.canvasHeight,
      );
    } else {
      next = resizeCropFromHandle(
        start,
        gesture.handle as CropResizeHandle,
        deltaX,
        deltaY,
        state.canvasWidth,
        state.canvasHeight,
      );
    }
    setDraftCrop(next);
    drawFrame();
  };

  const onPointerUp = (e?: PointerEvent) => {
    if (e) {
      activePointers.delete(e.pointerId);
    }
    if (pressedArtboardChrome()?.kind === "close" && e && stageRef) {
      const rect = stageRef.getBoundingClientRect();
      const releasedClose = artboardCloseAtPoint(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      const pressedClose = pressedArtboardChrome();
      setPressedArtboardChrome(null);
      if (
        pressedClose?.kind === "close" &&
        releasedClose?.id === pressedClose.artboardId
      ) {
        requestArtboardClose(pressedClose.artboardId);
      }
      return;
    }
    if (gesture?.kind === "artboard") {
      const shouldSelect = !gesture.moved && gesture.artboardId !== state.selectedArtboardId;
      const artboardId = gesture.artboardId;
      const artboardPointerId = gesture.pointerId;
      setPressedArtboardChrome(null);
      gesture = null;
      if (shouldSelect) {
        requestArtboardSelection(artboardId);
      }
      if (
        stageRef &&
        e &&
        stageRef.hasPointerCapture(artboardPointerId)
      ) {
        stageRef.releasePointerCapture(artboardPointerId);
      }
      return;
    }
    setPressedArtboardChrome(null);
    if (gesture?.kind === "brush_paint") {
      if (stageRef && e && stageRef.hasPointerCapture(e.pointerId)) {
        stageRef.releasePointerCapture(e.pointerId);
      }
      gesture = null;
      // Refresh GPU preview after stroke is committed
      void refreshPreview();
      return;
    }
    if (
      (gesture?.kind === "crop" ||
        gesture?.kind === "mask") &&
      stageRef &&
      e &&
      stageRef.hasPointerCapture(e.pointerId)
    ) {
      stageRef.releasePointerCapture(e.pointerId);
    }
    if (gesture?.kind === "mask") {
      const mp = draftMask();
      if (mp) {
        const idx = state.selectedLayerIdx;
        if (mp.kind === "linear") {
          void applyGradientMask({
            kind: "linear",
            layer_idx: idx,
            x1: mp.x1 ?? 0,
            y1: mp.y1 ?? 0,
            x2: mp.x2 ?? 0,
            y2: mp.y2 ?? 0,
          });
        } else {
          void applyGradientMask({
            kind: "radial",
            layer_idx: idx,
            cx: mp.cx ?? 0,
            cy: mp.cy ?? 0,
            radius: mp.radius ?? 0,
          });
        }
        setDraftMask(null);
      }
      gesture = null;
      return;
    }
    if (gesture?.kind === "crop") {
      const crop = draftCrop();
      if (crop && selectedCropLayer()) {
        void applyEdit({
          layer_idx: state.selectedLayerIdx,
          op: "crop",
          crop_x: crop.x,
          crop_y: crop.y,
          crop_width: crop.width,
          crop_height: crop.height,
          crop_rotation: crop.rotation,
        });
      }
      gesture = null;
      return;
    }
    if (gesture?.kind === "pinch") {
      void refreshPreview();
      if (activePointers.size === 1) {
        const [p] = [...activePointers.values()];
        gesture = {
          kind: "pan",
          x: p.x,
          y: p.y,
          startX: p.x,
          startY: p.y,
          moved: true,
          tapArtboardId: null,
        };
      } else {
        gesture = null;
      }
      return;
    }
    if (gesture?.kind === "pan") {
      const tappedArtboardId = !gesture.moved ? gesture.tapArtboardId : null;
      void refreshPreview();
      gesture = null;
      if (tappedArtboardId && tappedArtboardId !== state.selectedArtboardId) {
        requestArtboardSelection(tappedArtboardId);
      }
      return;
    }
    gesture = null;
  };

  createEffect(() => {
    previewTile();
    backdropTile();
    state.selectedArtboardId;
    state.selectedLayerIdx;
    if (lastStagePointer) {
      updateViewportToneFromPointer(lastStagePointer.x, lastStagePointer.y);
      return;
    }
    updateSmoothedToneSample(null);
  });

  onCleanup(() => {
    stopToneSmoothing();
  });

  return (
    <section class="relative flex min-h-[42vh] flex-1 overflow-hidden lg:min-h-0">
      <div
        ref={stageRef}
        class="relative flex-1 overflow-hidden bg-[var(--canvas-bg)]"
        style={{ "touch-action": "none", cursor: brushCursorStyle() }}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={(e) => {
          lastStagePointer = null;
          updateSmoothedToneSample(null);
          onPointerUp(e);
        }}
        onPointerCancel={(e) => {
          lastStagePointer = null;
          updateSmoothedToneSample(null);
          onPointerUp(e);
        }}
      >
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--canvas-highlight),_transparent_45%)]" />

        <div
          ref={containerRef}
          class="relative flex h-full w-full items-center justify-center lg:h-full"
        >
          <canvas
            ref={canvasRef}
            width="800"
            height="600"
            onDblClick={() => resetViewport()}
            style={{
              width: "100%",
              height: "100%",
            }}
            class={`${
              state.artboards.length === 0 && !state.isLoading ? "opacity-0" : "opacity-100"
            }`}
          />

          {selectedCropLayer() && activeCrop() && (
            <div class="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur">
              <span>Crop</span>
              <select
                value={cropAspectRatioPreset()}
                onChange={(event) =>
                  void applyCropAspectRatioPreset(
                    event.currentTarget.value as CropAspectRatioPreset,
                  )
                }
                class="pointer-events-auto rounded-full border border-white/10 bg-black/30 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 outline-none transition-colors hover:border-white/20 focus-visible:border-white/30"
              >
                <For each={CROP_ASPECT_RATIO_OPTIONS}>
                  {(option) => <option value={option.value}>{option.label}</option>}
                </For>
              </select>
            </div>
          )}
          {activeMask() && (
            <div
              class="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur"
              style={{ "pointer-events": activeMask()?.kind === "brush" ? "auto" : "none" }}
            >
              <span>Mask</span>
              <span class="text-white/35">
                {activeMask()?.kind === "linear"
                  ? "Linear"
                  : activeMask()?.kind === "radial"
                    ? "Radial"
                    : "Brush"}
              </span>
              <div class="flex items-center gap-4">
                {activeMask()?.kind === "brush" && (
                  <>
                    <div class="h-3.5 w-px bg-white/20" />
                    <Slider
                      label="Size"
                      value={brushSize()}
                      defaultValue={100}
                      min={5}
                      max={500}
                      step={1}
                      valueLabel={`${brushSize()}px`}
                      onChange={setBrushSize}
                      containerClass="flex items-center gap-1.5"
                      sliderClass="w-[150px]!"
                      tooltip
                    />
                    <div class="h-3.5 w-px bg-white/20" />
                    <Slider
                      label="Softness"
                      value={brushSoftness()}
                      defaultValue={0.5}
                      min={0}
                      max={1}
                      step={0.01}
                      valueLabel={`${Math.round(brushSoftness() * 100)}%`}
                      onChange={setBrushSoftness}
                      containerClass="flex items-center gap-1.5"
                      sliderClass="w-[150px]!"
                      tooltip
                    />
                  </>
                )}
              </div>
            </div>
          )}
          {shouldShowZoomIndicator() && viewportZoomPercent() !== null && (
            <Button
              type="button"
              class={`absolute ${zoomIndicatorPositionClass()} flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur transition hover:border-white/20 hover:bg-black/60`}
              onClick={() => resetViewport()}
            >
              <span>Zoom</span>
              <span class="text-white/35">{viewportZoomPercent()}%</span>
            </Button>
          )}
          <Show when={mediaRatingIdForArtboard(selectedArtboard()) !== null}>
            <MediaRating
              rating={selectedArtboardRating()}
              pending={isSavingRating()}
              onChange={(rating) => void handleSetRating(rating)}
              class="absolute bottom-4 left-1/2 -translate-x-1/2"
            />
          </Show>
          {state.layers.length === 0 && !state.isLoading && (
            <div class="pointer-events-none absolute flex max-w-sm flex-col items-center gap-3 rounded-[26px] border border-white/8 bg-black/40 px-8 py-10 text-center backdrop-blur-sm">
              <div class="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/6 text-white/80">
                <svg
                  width="24px"
                  height="24px"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  class="h-6 w-6"
                >
                  <path d="M12 16V6" />
                  <path d="m7.5 10.5 4.5-4.5 4.5 4.5" />
                  <path d="M4 18.5h16" />
                </svg>
              </div>
              <div>
                <div class="text-lg font-semibold tracking-[-0.02em] text-white">
                  {state.loadError
                    ? "Cannot open images in this browser"
                    : !state.webgpuAvailable
                      ? "WebGPU is unavailable"
                      : "Drop an image to start"}
                </div>
                <div class="mt-1 text-sm text-white/48">
                  {state.loadError ??
                    state.webgpuReason ??
                    "Drag a photo into the stage or use the Open action in the top bar."}
                </div>
              </div>
            </div>
          )}
        </div>

        {dragging() && (
          <div class="absolute inset-4 flex items-center justify-center rounded-[24px] border border-dashed border-white/35 bg-black/55 backdrop-blur-sm">
            <span class="rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-white">
              Release to open image
            </span>
          </div>
        )}
      </div>
    </section>
  );
};
