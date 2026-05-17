import { createSignal } from "solid-js";
import type { ArtboardViewport, PreviewQuality } from "../bridge/channel";
import type { PreviewFrame } from "../bridge/index";
import type { RenderedTile as PushedRenderedTile } from "../bridge/preview";
import {
  getArtboardTiles,
  getCurrentGeneration,
  nextGeneration,
  renderPreview,
  subscribeTiles,
} from "../data/preview-render";
import { isTauriRuntime } from "../data/runtime";
import {
  fullCanvasCrop,
  getCommittedCropRect,
  isAdjustmentSliderActive,
  selectedLayerIsCrop,
  setSelectedArtboardBackdropTile,
  setSelectedArtboardPreviewTile,
  setState,
  state,
} from "../store/editor-store";
import { releaseTileSurface } from "./compositor";
import { computeFitScale } from "./transform";
import type { FitReference, RenderedTile } from "./types";

export const [previewTile, setPreviewTile] = createSignal<RenderedTile | null>(null);
export const [backdropTile, setBackdropTile] = createSignal<RenderedTile | null>(null);

const PREVIEW_ARTBOARD_ID = "primary:preview";
const BACKDROP_ARTBOARD_ID = "primary:backdrop";
const INTERACTIVE_SCALE = 0.33;
const MIN_ZOOM = 0.1;
const MAX_IMAGE_SCALE = 8;

let previewSuspended = false;
let finalPreviewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let tileSubscriberInstalled = false;
let isTauriPlatform: boolean | null = null;

interface ViewportSpec {
  target_width: number;
  target_height: number;
  crop: { x: number; y: number; width: number; height: number };
  ignore_crop_layers: boolean;
}

async function ensurePlatformDetected(): Promise<boolean> {
  if (isTauriPlatform === null) {
    isTauriPlatform = await isTauriRuntime();
  }
  return isTauriPlatform;
}

function installTileSubscriber() {
  if (tileSubscriberInstalled) return;
  tileSubscriberInstalled = true;
  subscribeTiles((artboardId) => {
    if (previewSuspended) return;
    const tiles = getArtboardTiles(artboardId);
    if (!tiles) return;
    const pick = tiles.final ?? tiles.interactive;
    if (!pick) return;
    if (artboardId === PREVIEW_ARTBOARD_ID) {
      applyPreviewTile(pick);
    } else if (artboardId === BACKDROP_ARTBOARD_ID) {
      applyBackdropTile(pick);
    }
  });
}

function applyPreviewTile(pushed: PushedRenderedTile) {
  const tile: RenderedTile = {
    image: pushed.image,
    x: pushed.x,
    y: pushed.y,
    width: pushed.width,
    height: pushed.height,
  };
  releaseTileSurface(previewTile()?.image ?? null);
  setPreviewTile(tile);
  setSelectedArtboardPreviewTile(tile);
  setState({
    previewDisplayColorSpace:
      pushed.image.colorSpace === "display-p3" ? "Display P3" : "sRGB",
    previewRenderWidth: pushed.image.width,
    previewRenderHeight: pushed.image.height,
  });
  // If the preview already covers the full artboard, reuse it as the backdrop.
  if (
    pushed.x <= 0 &&
    pushed.y <= 0 &&
    pushed.width >= state.canvasWidth &&
    pushed.height >= state.canvasHeight
  ) {
    applyBackdropTile(pushed);
  }
}

function applyBackdropTile(pushed: PushedRenderedTile) {
  const tile: RenderedTile = {
    image: pushed.image,
    x: pushed.x,
    y: pushed.y,
    width: pushed.width,
    height: pushed.height,
  };
  releaseTileSurface(backdropTile()?.image ?? null);
  setBackdropTile(tile);
  setSelectedArtboardBackdropTile(tile);
}

export function clearPreviewTiles() {
  releaseTileSurface(previewTile()?.image ?? null);
  releaseTileSurface(backdropTile()?.image ?? null);
  setPreviewTile(null);
  setBackdropTile(null);
  // Bump generation so any in-flight pushed frames are discarded.
  nextGeneration();
}

export function suspendPreview() {
  previewSuspended = true;
  clearPreviewTiles();
}

export function resumePreview() {
  previewSuspended = false;
}

export function resetPreviewLatencyEstimate() {
  // Retained for API compatibility — Rust now owns scheduling latency.
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
  return Math.round(
    computeFitScale({ width: w, height: h }, fit) * state.viewportZoom * 100,
  );
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
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
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
  const cx = centerX;
  const cy = centerY;

  const committedCrop = !selectedLayerIsCrop() ? getCommittedCropRect() : null;
  if (committedCrop && Math.abs(committedCrop.rotation) > 0.001) {
    const rot = committedCrop.rotation;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const absCos = Math.abs(cos);
    const absSin = Math.abs(sin);
    const cropCX = fit.x + fit.width * 0.5;
    const cropCY = fit.y + fit.height * 0.5;
    const localX = cx - cropCX;
    const localY = cy - cropCY;
    const imgCX = cropCX + localX * cos - localY * sin;
    const imgCY = cropCY + localX * sin + localY * cos;
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

function buildPreviewSpec(quality: PreviewQuality): ViewportSpec | null {
  const visible = getVisibleRegion(
    state.viewportZoom,
    state.viewportCenterX,
    state.viewportCenterY,
  );
  if (!visible) return null;
  const inCropEdit = selectedLayerIsCrop();
  const hasRotation = !inCropEdit && Math.abs(getCommittedCropRect().rotation) > 0.001;
  const dpr =
    (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  return {
    target_width: Math.max(1, Math.round(visible.screenWidth * dpr)),
    target_height: Math.max(1, Math.round(visible.screenHeight * dpr)),
    crop: visible.crop,
    ignore_crop_layers: inCropEdit || hasRotation,
  };
}

function buildBackdropSpec(quality: PreviewQuality): ViewportSpec | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const inCropEdit = selectedLayerIsCrop();
  const committedCrop = inCropEdit ? null : getCommittedCropRect();
  const hasRotation = committedCrop ? Math.abs(committedCrop.rotation) > 0.001 : false;
  const crop =
    inCropEdit || hasRotation
      ? {
          x: 0,
          y: 0,
          width: state.canvasWidth,
          height: state.canvasHeight,
        }
      : (committedCrop ?? {
          x: 0,
          y: 0,
          width: state.canvasWidth,
          height: state.canvasHeight,
        });
  const { viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  const dpr =
    (window.devicePixelRatio || 1) * (quality === "interactive" ? INTERACTIVE_SCALE : 1);
  const fitted = fitPreviewSize(sw * dpr, sh * dpr, crop.width, crop.height);
  if (fitted.width <= 0 || fitted.height <= 0) return null;
  return {
    target_width: fitted.width,
    target_height: fitted.height,
    crop,
    ignore_crop_layers: true,
  };
}

function specToViewport(
  artboardId: string,
  spec: ViewportSpec,
  priority: number,
): ArtboardViewport {
  return {
    artboard_id: artboardId,
    crop: spec.crop,
    target_width: spec.target_width,
    target_height: spec.target_height,
    priority,
    ignore_crop_layers: spec.ignore_crop_layers,
  };
}

function previewFrameToImageData(frame: PreviewFrame): ImageData {
  if (frame.kind === "rgba-float16") {
    return new ImageData(frame.pixels as never, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.colorSpace,
    } as ImageDataSettings);
  }
  const pixels = new Uint8ClampedArray(
    frame.pixels.buffer as ArrayBuffer,
    frame.pixels.byteOffset,
    frame.pixels.byteLength,
  );
  return new ImageData(pixels, frame.width, frame.height);
}

async function browserRefresh(quality: PreviewQuality) {
  const previewSpec = buildPreviewSpec(quality);
  const backdropSpec = buildBackdropSpec(quality);
  if (!previewSpec) return;
  const previewFrame = await renderPreview({
    target_width: previewSpec.target_width,
    target_height: previewSpec.target_height,
    crop: previewSpec.crop,
    ignore_crop_layers: previewSpec.ignore_crop_layers,
  });
  if (previewSuspended) return;
  if (previewFrame.width === 0 || previewFrame.height === 0) return;
  const previewImage = previewFrameToImageData(previewFrame);
  applyPreviewTile({
    image: previewImage,
    x: previewSpec.crop.x,
    y: previewSpec.crop.y,
    width: previewSpec.crop.width,
    height: previewSpec.crop.height,
  });
  if (!backdropSpec) return;
  // If preview covers the whole canvas, applyPreviewTile already mirrored to backdrop.
  if (
    previewSpec.crop.x <= 0 &&
    previewSpec.crop.y <= 0 &&
    previewSpec.crop.width >= state.canvasWidth &&
    previewSpec.crop.height >= state.canvasHeight
  ) {
    return;
  }
  const backdropFrame = await renderPreview({
    target_width: backdropSpec.target_width,
    target_height: backdropSpec.target_height,
    crop: backdropSpec.crop,
    ignore_crop_layers: backdropSpec.ignore_crop_layers,
  });
  if (previewSuspended) return;
  if (backdropFrame.width === 0 || backdropFrame.height === 0) return;
  applyBackdropTile({
    image: previewFrameToImageData(backdropFrame),
    x: backdropSpec.crop.x,
    y: backdropSpec.crop.y,
    width: backdropSpec.crop.width,
    height: backdropSpec.crop.height,
  });
}

async function tauriRefresh(quality: PreviewQuality) {
  installTileSubscriber();
  const previewSpec = buildPreviewSpec(quality);
  const backdropSpec = buildBackdropSpec(quality);
  const viewports: ArtboardViewport[] = [];
  if (previewSpec) {
    viewports.push(specToViewport(PREVIEW_ARTBOARD_ID, previewSpec, 0));
  }
  if (backdropSpec) {
    viewports.push(specToViewport(BACKDROP_ARTBOARD_ID, backdropSpec, 1));
  }
  if (viewports.length === 0) return;
  const generation = nextGeneration();
  const { getTransport } = await import("../bridge/transport");
  getTransport().sendPreviewViewports({
    generation,
    quality,
    viewports,
    use_float16: supportsFloat16Preview(),
  });
}

let float16PreviewSupport: boolean | null = null;
function supportsFloat16Preview() {
  if (float16PreviewSupport !== null) return float16PreviewSupport;
  if (typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent)) {
    float16PreviewSupport = false;
    return false;
  }
  const Float16 = (globalThis as { Float16Array?: unknown }).Float16Array;
  if (typeof ImageData === "undefined" || !Float16) {
    float16PreviewSupport = false;
    return false;
  }
  try {
    const probe = new (Float16 as new (b: ArrayBufferLike) => unknown)(
      new Uint16Array(4).buffer,
    );
    new ImageData(probe as never, 1, 1, {
      pixelFormat: "rgba-float16",
      colorSpace: "display-p3",
    } as ImageDataSettings);
    float16PreviewSupport = true;
  } catch {
    float16PreviewSupport = false;
  }
  return float16PreviewSupport;
}

async function dispatchRefresh(quality: PreviewQuality) {
  if (previewSuspended) return;
  if (await ensurePlatformDetected()) {
    await tauriRefresh(quality);
  } else {
    await browserRefresh(quality);
  }
}

export function refreshPreview() {
  const quality: PreviewQuality = isAdjustmentSliderActive() ? "interactive" : "final";
  return dispatchRefresh(quality);
}

export function refreshFinalPreview() {
  if (finalPreviewDebounceTimer !== null) {
    clearTimeout(finalPreviewDebounceTimer);
    finalPreviewDebounceTimer = null;
  }
  return dispatchRefresh("final");
}

function debounceFinalPreviewRefresh(delayMs = 120) {
  if (previewSuspended) return;
  if (finalPreviewDebounceTimer !== null) {
    clearTimeout(finalPreviewDebounceTimer);
  }
  finalPreviewDebounceTimer = setTimeout(() => {
    finalPreviewDebounceTimer = null;
    void dispatchRefresh("final");
  }, delayMs);
}

export function setViewportScreenSize(width: number, height: number) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === state.viewportScreenWidth && h === state.viewportScreenHeight) return;
  setState({ viewportScreenWidth: w, viewportScreenHeight: h });
  void refreshPreview();
}

export function resetViewport() {
  const fit = getViewportFitRef();
  setState({
    viewportZoom: 1,
    viewportCenterX: fit.x + fit.width * 0.5,
    viewportCenterY: fit.y + fit.height * 0.5,
  });
  void refreshFinalPreview();
}

export function zoomViewport(
  delta: number,
  pinch: boolean,
  anchorX: number,
  anchorY: number,
) {
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
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(getMaxViewportZoom(), viewportZoom * multiplier),
  );
  const newScale = fitScale * zoom;
  const vcx = sw * 0.5;
  const vcy = sh * 0.5;
  const anchoredX = viewportCenterX + (anchorX - vcx) / oldScale;
  const anchoredY = viewportCenterY + (anchorY - vcy) / oldScale;
  setState({
    viewportZoom: zoom,
    viewportCenterX: anchoredX - (anchorX - vcx) / newScale,
    viewportCenterY: anchoredY - (anchorY - vcy) / newScale,
  });
  // Send interactive immediately for snappy zoom feel; final follows after pause.
  void dispatchRefresh("interactive");
  debounceFinalPreviewRefresh();
}

export function panViewport(deltaX: number, deltaY: number, shouldRefresh = true) {
  const { viewportZoom, viewportScreenWidth: sw, viewportScreenHeight: sh } = state;
  if (sw <= 0 || sh <= 0) return;
  const fit = getViewportFitRef();
  const fitScale = computeFitScale({ width: sw, height: sh }, fit);
  const imageScale = fitScale * viewportZoom;
  setState({
    viewportCenterX: state.viewportCenterX - deltaX / imageScale,
    viewportCenterY: state.viewportCenterY - deltaY / imageScale,
  });
  if (shouldRefresh) {
    void dispatchRefresh("interactive");
    debounceFinalPreviewRefresh();
  }
}

export function offsetViewportCenter(deltaX: number, deltaY: number) {
  setState({
    viewportCenterX: state.viewportCenterX + deltaX,
    viewportCenterY: state.viewportCenterY + deltaY,
  });
  void refreshPreview();
}

export function setViewportState(params: {
  centerX?: number;
  centerY?: number;
  zoom?: number;
}) {
  if (state.canvasWidth <= 0) {
    throw new Error("cannot set viewport without a loaded image");
  }
  const nextCenterX = params.centerX ?? state.viewportCenterX;
  const nextCenterY = params.centerY ?? state.viewportCenterY;
  const nextZoom = params.zoom ?? state.viewportZoom;
  if (!Number.isFinite(nextCenterX) || !Number.isFinite(nextCenterY)) {
    throw new Error("viewport center must be finite");
  }
  if (!Number.isFinite(nextZoom)) {
    throw new Error("viewport zoom must be finite");
  }
  setState({
    viewportCenterX: nextCenterX,
    viewportCenterY: nextCenterY,
    viewportZoom: Math.max(MIN_ZOOM, Math.min(getMaxViewportZoom(), nextZoom)),
  });
  void refreshPreview();
}

export { getCurrentGeneration as getCurrentPreviewGeneration };
