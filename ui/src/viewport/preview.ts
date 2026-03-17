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

export function clearPreviewTiles() {
  setPreviewTile(null);
  setBackdropTile(null);
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
function getVisibleRegion(zoom: number, centerX: number, centerY: number) {
  const fit = getViewportFitRef();
  const { viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  if (sw <= 0 || sh <= 0 || fit.width <= 0 || fit.height <= 0) return null;
  const fitScale = computeFitScale({ width: sw, height: sh }, fit);
  const imageScale = fitScale * zoom;
  const visW = sw / imageScale;
  const visH = sh / imageScale;
  // Clamped center
  const cx = Math.max(fit.x + visW * 0.5, Math.min(centerX, fit.x + fit.width - visW * 0.5));
  const cy = Math.max(fit.y + visH * 0.5, Math.min(centerY, fit.y + fit.height - visH * 0.5));
  // Artboard image top-left in screen coords
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
  const dpr = (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  return {
    target_width: Math.max(1, Math.round(visible.screenWidth * dpr)),
    target_height: Math.max(1, Math.round(visible.screenHeight * dpr)),
    crop: visible.crop,
    ignore_crop_layers: selectedLayerIsCrop(),
  };
}

function buildBackdropRequest(quality: "interactive" | "final"): bridge.PreviewRequest | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const crop = selectedLayerIsCrop() ? undefined : getCommittedCropRect();
  const { viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  const dpr = (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  const fitted = fitPreviewSize(
    sw * dpr,
    sh * dpr,
    crop?.width ?? state.canvasWidth,
    crop?.height ?? state.canvasHeight,
  );
  if (fitted.width <= 0 || fitted.height <= 0) return null;
  return {
    target_width: fitted.width,
    target_height: fitted.height,
    crop,
    ignore_crop_layers: true,
  };
}

function cropMatches(a: bridge.PreviewCrop, b: bridge.PreviewCrop) {
  const eps = 0.01;
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

async function performRefresh() {
  const queued = refreshQueued;
  if (!queued) return;
  refreshQueued = null;
  const previewReq = buildPreviewRequest(queued.quality);
  const backdropReq = buildBackdropRequest(queued.quality);
  if (!previewReq || !backdropReq) return;
  const frame = await throttledRender(previewReq);
  if (queued.version !== refreshVersion) return;
  if (frame.width === 0 || frame.height === 0) return;
  const crop = previewReq.crop;
  if (!crop) throw new Error("preview request must have a crop");
  // Stale check: re-request if viewport moved while rendering
  const currentVisible = getVisibleRegion(
    state.viewportZoom,
    state.viewportCenterX,
    state.viewportCenterY,
  );
  if (!currentVisible || !cropMatches(crop, currentVisible.crop)) {
    refreshPreview();
    return;
  }
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
  setPreviewTile(toRenderedTile(frame, crop));
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
