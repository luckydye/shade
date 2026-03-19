import { createSignal } from "solid-js";
import * as bridge from "../bridge/index";
import {
  fullCanvasCrop,
  getCommittedCropRect,
  selectedLayerIsCrop,
  setState,
  state,
} from "../store/editor-store";
import type { FitReference, RenderedTile } from "./types";
import { clampCamera, computeFitScale } from "./transform";

export const [previewTile, setPreviewTile] = createSignal<RenderedTile | null>(null);
export const [backdropTile, setBackdropTile] = createSignal<RenderedTile | null>(null);

const INTERACTIVE_SCALE = 0.33;
const THROTTLE_MS = 16;
const MIN_ZOOM = 0.1;
const MAX_IMAGE_SCALE = 8;

let refreshVersion = 0;
let refreshQueued: { version: number; quality: "interactive" | "final" } | null = null;
let refreshPromise: Promise<void> | null = null;
let refreshLastStartAt = 0;
let refreshWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
let lastRenderedPreview:
  | { quality: "interactive" | "final"; snapshot: RefreshSnapshot; request: bridge.PreviewRequest }
  | null = null;
let lastRenderedBackdrop:
  | { quality: "interactive" | "final"; snapshot: RefreshSnapshot; request: bridge.PreviewRequest }
  | null = null;

type RefreshSnapshot = {
  viewportZoom: number;
  viewportCenterX: number;
  viewportCenterY: number;
  viewportScreenWidth: number;
  viewportScreenHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  selectedLayerIdx: number;
  cropMode: boolean;
  committedCropX: number;
  committedCropY: number;
  committedCropWidth: number;
  committedCropHeight: number;
  committedCropRotation: number;
};

export function clearPreviewTiles() {
  setPreviewTile(null);
  setBackdropTile(null);
  lastRenderedPreview = null;
  lastRenderedBackdrop = null;
}

export function getViewportFitRef(): FitReference {
  return selectedLayerIsCrop() ? fullCanvasCrop() : getCommittedCropRect();
}

export function getViewportFitScale(): number {
  const fit = getViewportFitRef();
  const { viewportScreenWidth: w, viewportScreenHeight: h } = state;
  if (w <= 0 || h <= 0 || fit.width <= 0 || fit.height <= 0) return 1;
  return computeFitScale({ width: w, height: h }, fit);
}

export function getViewportZoomPercent(): number | null {
  const { viewportScreenWidth: w, viewportScreenHeight: h } = state;
  if (w <= 0 || h <= 0) return null;
  const fit = getViewportFitRef();
  if (fit.width <= 0 || fit.height <= 0) return null;
  return Math.round(computeFitScale({ width: w, height: h }, fit) * state.viewportZoom * 100);
}

export function getMaxViewportZoom(): number {
  return Math.max(1, MAX_IMAGE_SCALE / getViewportFitScale());
}

export function fitPreviewSize(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
) {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  return {
    width: Math.max(1, Math.floor(imageWidth * scale)),
    height: Math.max(1, Math.floor(imageHeight * scale)),
  };
}

export function getViewportDisplaySize() {
  const fit = getViewportFitRef();
  return fitPreviewSize(
    state.viewportScreenWidth,
    state.viewportScreenHeight,
    fit.width,
    fit.height,
  );
}

// Compute the visible artboard region at the given viewport state.
// For rotated crops the "visible region" is the bounding box of the visible
// sub-region rotated back into original image space, because the compositor
// counter-rotates the canvas and we need the underlying unrotated pixels.
function getVisibleRegion(zoom: number, centerX: number, centerY: number) {
  const fit = getViewportFitRef();
  const { viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  if (sw <= 0 || sh <= 0 || fit.width <= 0 || fit.height <= 0) return null;
  const fitScale = computeFitScale({ width: sw, height: sh }, fit);
  const imageScale = fitScale * zoom;
  const visW = sw / imageScale;
  const visH = sh / imageScale;
  // Clamped center (in output/fit-ref space)
  const cx = Math.max(fit.x + visW * 0.5, Math.min(centerX, fit.x + fit.width - visW * 0.5));
  const cy = Math.max(fit.y + visH * 0.5, Math.min(centerY, fit.y + fit.height - visH * 0.5));

  const committedCrop = !selectedLayerIsCrop() ? getCommittedCropRect() : null;
  if (committedCrop && Math.abs(committedCrop.rotation) > 0.001) {
    // For rotated crops, the compositor counter-rotates the canvas so tiles must
    // provide the original (unrotated) image content. Compute the bounding box of
    // the currently visible output sub-region rotated back into image space.
    const rot = committedCrop.rotation;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const absCos = Math.abs(cos);
    const absSin = Math.abs(sin);
    const cropCX = fit.x + fit.width * 0.5;
    const cropCY = fit.y + fit.height * 0.5;
    // Rotate the visible sub-region center from output space to image space
    const localX = cx - cropCX;
    const localY = cy - cropCY;
    const imgCX = cropCX + localX * cos - localY * sin;
    const imgCY = cropCY + localX * sin + localY * cos;
    // Bounding box of the visible rectangle rotated by `rot`
    const bbHalfW = (visW * absCos + visH * absSin) * 0.5;
    const bbHalfH = (visW * absSin + visH * absCos) * 0.5;
    const x = Math.max(0, imgCX - bbHalfW);
    const y = Math.max(0, imgCY - bbHalfH);
    const x2 = Math.min(state.canvasWidth, imgCX + bbHalfW);
    const y2 = Math.min(state.canvasHeight, imgCY + bbHalfH);
    if (x2 <= x || y2 <= y) return null;
    return {
      screenWidth: (x2 - x) * imageScale,
      screenHeight: (y2 - y) * imageScale,
      crop: { x, y, width: x2 - x, height: y2 - y },
    };
  }

  // Axis-aligned case
  const imageX = sw * 0.5 - (cx - fit.x) * imageScale;
  const imageY = sh * 0.5 - (cy - fit.y) * imageScale;
  const screenLeft = Math.max(0, imageX);
  const screenTop = Math.max(0, imageY);
  const screenRight = Math.min(sw, imageX + fit.width * imageScale);
  const screenBottom = Math.min(sh, imageY + fit.height * imageScale);
  if (screenRight <= screenLeft || screenBottom <= screenTop) return null;
  return {
    screenWidth: screenRight - screenLeft,
    screenHeight: screenBottom - screenTop,
    crop: {
      x: fit.x + (screenLeft - imageX) / imageScale,
      y: fit.y + (screenTop - imageY) / imageScale,
      width: (screenRight - screenLeft) / imageScale,
      height: (screenBottom - screenTop) / imageScale,
    },
  };
}

function toRenderedTile(frame: bridge.PreviewFrame, crop: bridge.PreviewCrop): RenderedTile {
  return {
    image: toImageData(frame),
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
  };
}

function toImageData(frame: bridge.PreviewFrame): ImageData {
  if (frame.kind === "rgba-float16") {
    return new ImageData(frame.pixels as any, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.colorSpace,
    } as any);
  }
  const pixels = new Uint8ClampedArray(
    frame.pixels.buffer,
    frame.pixels.byteOffset,
    frame.pixels.byteLength,
  ) as any;
  return new ImageData(pixels, frame.width, frame.height);
}

async function throttledRender(request: bridge.PreviewRequest) {
  const elapsed = Date.now() - refreshLastStartAt;
  if (elapsed < THROTTLE_MS) {
    await new Promise<void>((r) => setTimeout(r, THROTTLE_MS - elapsed));
  }
  refreshLastStartAt = Date.now();
  return bridge.renderPreview(request);
}

function buildPreviewRequest(quality: "interactive" | "final"): bridge.PreviewRequest | null {
  const visible = getVisibleRegion(
    state.viewportZoom,
    state.viewportCenterX,
    state.viewportCenterY,
  );
  if (!visible) return null;
  const inCropEdit = selectedLayerIsCrop();
  // For rotated crops the compositor counter-rotates the canvas, so we need unrotated
  // image content from the engine (ignore_crop_layers: true). For axis-aligned crops
  // the engine applies the crop layer normally.
  const hasRotation =
    !inCropEdit && Math.abs(getCommittedCropRect().rotation) > 0.001;
  const dpr = (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  return {
    target_width: Math.max(1, Math.round(visible.screenWidth * dpr)),
    target_height: Math.max(1, Math.round(visible.screenHeight * dpr)),
    crop: visible.crop,
    ignore_crop_layers: inCropEdit || hasRotation,
  };
}

function buildBackdropRequest(quality: "interactive" | "final"): bridge.PreviewRequest | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const inCropEdit = selectedLayerIsCrop();
  const committedCrop = inCropEdit ? null : getCommittedCropRect();
  const hasRotation = committedCrop ? Math.abs(committedCrop.rotation) > 0.001 : false;
  // For rotated crops the compositor counter-rotates the canvas, so the backdrop
  // must cover the full artboard (the rotated crop bounding box could extend anywhere).
  // For axis-aligned crops we only need the committed crop region.
  const crop = inCropEdit || hasRotation ? undefined : committedCrop ?? undefined;
  const baseW = crop?.width ?? state.canvasWidth;
  const baseH = crop?.height ?? state.canvasHeight;
  const { viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  const dpr = (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  const fitted = fitPreviewSize(sw * dpr, sh * dpr, baseW, baseH);
  if (fitted.width <= 0 || fitted.height <= 0) return null;
  return {
    target_width: fitted.width,
    target_height: fitted.height,
    crop,
    ignore_crop_layers: true,
  };
}

function captureRefreshSnapshot(): RefreshSnapshot {
  const committedCrop = getCommittedCropRect();
  return {
    viewportZoom: state.viewportZoom,
    viewportCenterX: state.viewportCenterX,
    viewportCenterY: state.viewportCenterY,
    viewportScreenWidth: state.viewportScreenWidth,
    viewportScreenHeight: state.viewportScreenHeight,
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    selectedLayerIdx: state.selectedLayerIdx,
    cropMode: selectedLayerIsCrop(),
    committedCropX: committedCrop.x,
    committedCropY: committedCrop.y,
    committedCropWidth: committedCrop.width,
    committedCropHeight: committedCrop.height,
    committedCropRotation: committedCrop.rotation,
  };
}

function refreshSnapshotMatches(snapshot: RefreshSnapshot) {
  const current = captureRefreshSnapshot();
  return (
    current.viewportZoom === snapshot.viewportZoom &&
    current.viewportCenterX === snapshot.viewportCenterX &&
    current.viewportCenterY === snapshot.viewportCenterY &&
    current.viewportScreenWidth === snapshot.viewportScreenWidth &&
    current.viewportScreenHeight === snapshot.viewportScreenHeight &&
    current.canvasWidth === snapshot.canvasWidth &&
    current.canvasHeight === snapshot.canvasHeight &&
    current.selectedLayerIdx === snapshot.selectedLayerIdx &&
    current.cropMode === snapshot.cropMode &&
    current.committedCropX === snapshot.committedCropX &&
    current.committedCropY === snapshot.committedCropY &&
    current.committedCropWidth === snapshot.committedCropWidth &&
    current.committedCropHeight === snapshot.committedCropHeight &&
    current.committedCropRotation === snapshot.committedCropRotation
  );
}

function previewRequestMatches(
  a: bridge.PreviewRequest,
  b: bridge.PreviewRequest,
) {
  const cropA = a.crop;
  const cropB = b.crop;
  const cropMatches =
    cropA === undefined && cropB === undefined
      ? true
      : cropA !== undefined &&
          cropB !== undefined &&
          cropA.x === cropB.x &&
          cropA.y === cropB.y &&
          cropA.width === cropB.width &&
          cropA.height === cropB.height;
  return (
    a.target_width === b.target_width &&
    a.target_height === b.target_height &&
    a.ignore_crop_layers === b.ignore_crop_layers &&
    cropMatches
  );
}

function canReuseRenderedPreview(
  cached:
    | { quality: "interactive" | "final"; snapshot: RefreshSnapshot; request: bridge.PreviewRequest }
    | null,
  quality: "interactive" | "final",
  snapshot: RefreshSnapshot,
  request: bridge.PreviewRequest,
  hasTile: boolean,
) {
  return (
    hasTile &&
    cached?.quality === quality &&
    refreshSnapshotMatches(cached.snapshot) &&
    refreshSnapshotMatches(snapshot) &&
    previewRequestMatches(cached.request, request)
  );
}

async function performRefresh() {
  const queued = refreshQueued;
  if (!queued) return;
  refreshQueued = null;
  const snapshot = captureRefreshSnapshot();
  const previewReq = buildPreviewRequest(queued.quality);
  const backdropReq = buildBackdropRequest(queued.quality);
  if (!previewReq || !backdropReq) return;
  if (
    canReuseRenderedPreview(
      lastRenderedPreview,
      queued.quality,
      snapshot,
      previewReq,
      previewTile() !== null,
    )
  ) {
    return;
  }
  const frame = await throttledRender(previewReq);
  if (queued.version !== refreshVersion) return;
  if (frame.width === 0 || frame.height === 0) return;
  const crop = previewReq.crop;
  if (!crop) throw new Error("preview request must have a crop");
  if (!refreshSnapshotMatches(snapshot)) {
    return;
  }
  if (queued.quality === "final") {
    setState({
      previewDisplayColorSpace:
        frame.kind === "rgba-float16"
          ? frame.colorSpace === "display-p3"
            ? "Display P3"
            : frame.colorSpace
          : "sRGB",
      previewRenderWidth: frame.width,
      previewRenderHeight: frame.height,
    });
  }
  setPreviewTile(toRenderedTile(frame, crop));
  lastRenderedPreview = {
    quality: queued.quality,
    snapshot,
    request: previewReq,
  };
  // If the preview already covers the full artboard, reuse it as the backdrop
  if (
    crop.x <= 0 &&
    crop.y <= 0 &&
    crop.width >= state.canvasWidth &&
    crop.height >= state.canvasHeight
  ) {
    setBackdropTile(toRenderedTile(frame, crop));
    return;
  }
  // Skip backdrop on interactive quality if we already have one
  if (queued.quality === "interactive" && backdropTile()) return;
  if (
    canReuseRenderedPreview(
      lastRenderedBackdrop,
      queued.quality,
      snapshot,
      backdropReq,
      backdropTile() !== null,
    )
  ) {
    return;
  }
  const bdFrame = await throttledRender(backdropReq);
  if (queued.version !== refreshVersion) return;
  if (bdFrame.width === 0 || bdFrame.height === 0) return;
  const bdCrop = backdropReq.crop ?? fullCanvasCrop();
  setBackdropTile(
    toRenderedTile(bdFrame, {
      x: bdCrop.x,
      y: bdCrop.y,
      width: bdCrop.width,
      height: bdCrop.height,
    }),
  );
  lastRenderedBackdrop = {
    quality: queued.quality,
    snapshot,
    request: backdropReq,
  };
}

export function refreshPreview() {
  refreshVersion += 1;
  const completion = new Promise<void>((resolve, reject) => {
    refreshWaiters.push({ resolve, reject });
  });
  if (refreshPromise) return completion;
  refreshPromise = (async () => {
    try {
      while (true) {
        const version = refreshVersion;
        refreshQueued = { version, quality: "interactive" };
        await performRefresh();
        if (version !== refreshVersion) continue;
        refreshQueued = { version, quality: "final" };
        await performRefresh();
        if (version !== refreshVersion) continue;
        const waiters = refreshWaiters;
        refreshWaiters = [];
        for (const w of waiters) w.resolve();
        return;
      }
    } catch (error) {
      const waiters = refreshWaiters;
      refreshWaiters = [];
      for (const w of waiters) w.reject(error);
    } finally {
      refreshPromise = null;
    }
  })();
  return completion;
}

export function setViewportScreenSize(width: number, height: number) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === state.viewportScreenWidth && h === state.viewportScreenHeight) return;
  setState({ viewportScreenWidth: w, viewportScreenHeight: h });
  refreshPreview();
}

export function resetViewport() {
  const fit = getViewportFitRef();
  setState({
    viewportZoom: 1,
    viewportCenterX: fit.x + fit.width * 0.5,
    viewportCenterY: fit.y + fit.height * 0.5,
  });
  refreshPreview();
}

export function zoomViewport(delta: number, pinch: boolean, anchorX: number, anchorY: number) {
  const {
    viewportScreenWidth: sw,
    viewportScreenHeight: sh,
    viewportZoom,
    viewportCenterX,
    viewportCenterY,
  } = state;
  if (state.canvasWidth <= 0 || sw <= 0 || sh <= 0) return;
  const fit = getViewportFitRef();
  const fitScale = computeFitScale({ width: sw, height: sh }, fit);
  const sensitivity = pinch ? 0.0005 : 0.001;
  const multiplier = Math.exp(-delta * sensitivity);
  const oldScale = fitScale * viewportZoom;
  const zoom = Math.max(MIN_ZOOM, Math.min(getMaxViewportZoom(), viewportZoom * multiplier));
  const newScale = fitScale * zoom;
  const vcx = sw * 0.5;
  const vcy = sh * 0.5;
  const anchoredX = viewportCenterX + (anchorX - vcx) / oldScale;
  const anchoredY = viewportCenterY + (anchorY - vcy) / oldScale;
  const camera = clampCamera(
    zoom,
    anchoredX - (anchorX - vcx) / newScale,
    anchoredY - (anchorY - vcy) / newScale,
    { width: sw, height: sh },
    fit,
  );
  setState({
    viewportZoom: camera.zoom,
    viewportCenterX: camera.centerX,
    viewportCenterY: camera.centerY,
  });
  refreshPreview();
}

export function panViewport(deltaX: number, deltaY: number) {
  const { viewportZoom, viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  if (viewportZoom <= 1 || sw <= 0 || sh <= 0) return;
  const fit = getViewportFitRef();
  const fitScale = computeFitScale({ width: sw, height: sh }, fit);
  const imageScale = fitScale * viewportZoom;
  const camera = clampCamera(
    viewportZoom,
    state.viewportCenterX - deltaX / imageScale,
    state.viewportCenterY - deltaY / imageScale,
    { width: sw, height: sh },
    fit,
  );
  setState({ viewportCenterX: camera.centerX, viewportCenterY: camera.centerY });
  refreshPreview();
}
