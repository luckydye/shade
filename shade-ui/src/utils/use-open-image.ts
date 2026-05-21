import { type Accessor, createSignal } from "solid-js";
import {
  type ArtboardSource,
  type ArtboardState,
  fullCanvasCrop,
  getCommittedCropRect,
  isAdjustmentSliderActive,
  selectedLayerIsCrop,
  setSelectedArtboardBackdropTile,
  setSelectedArtboardPreviewTile,
  setState,
  state,
} from "../store/editor-store";
import { resetHistory } from "../store/history";
import { isTauriRuntime } from "../utils";
import { releaseTileSurface } from "@shade/viewport/compositor";
import { computeFitScale } from "@shade/viewport/transform";
import type { FitReference, RenderedTile } from "@shade/viewport/types";
import {
  type ArtboardViewport,
  type PreviewFrame,
  type PreviewQuality,
  type PushedRenderedTile,
  type SharedPicture,
  useImageBridge,
} from "./use-image-bridge";
import { useLayerStack } from "./use-layer-stack";

// ── Module state ────────────────────────────────────────────────────────────

const [previewTile, setPreviewTile] = createSignal<RenderedTile | null>(null);
const [backdropTile, setBackdropTile] = createSignal<RenderedTile | null>(null);

const PREVIEW_ARTBOARD_ID = "primary:preview";
const BACKDROP_ARTBOARD_ID = "primary:backdrop";
const INTERACTIVE_SCALE = 0.33;
const MIN_ZOOM = 0.1;
const MAX_IMAGE_SCALE = 8;
const ARTBOARD_GAP = 96;
const DEFAULT_PENDING_ARTBOARD_WIDTH = 1600;
const DEFAULT_PENDING_ARTBOARD_HEIGHT = 1200;
const SUPERSEDED_IMAGE_LOAD_ERROR = "image load superseded by newer request";

let previewSuspended = false;
let finalPreviewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let tileSubscriberInstalled = false;
let isTauriPlatform: boolean | null = null;
let activeLoadToken = 0;
const imageBridge = useImageBridge();

type OpenImageMode = "append" | "replace";

interface ViewportSpec {
  target_width: number;
  target_height: number;
  crop: { x: number; y: number; width: number; height: number };
  ignore_crop_layers: boolean;
}

// ── Preview tile subscriber & application ───────────────────────────────────

function ensurePlatformDetected(): boolean {
  if (isTauriPlatform === null) {
    isTauriPlatform = isTauriRuntime();
  }
  return isTauriPlatform;
}

function installTileSubscriber() {
  if (tileSubscriberInstalled) return;
  tileSubscriberInstalled = true;
  imageBridge.subscribeTiles((artboardId) => {
    if (previewSuspended) return;
    const tiles = imageBridge.getArtboardTiles(artboardId);
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

function clearPreviewTiles() {
  releaseTileSurface(previewTile()?.image ?? null);
  releaseTileSurface(backdropTile()?.image ?? null);
  setPreviewTile(null);
  setBackdropTile(null);
  // Bump generation so any in-flight pushed frames are discarded.
  imageBridge.nextGeneration();
}

function suspendPreview() {
  previewSuspended = true;
  clearPreviewTiles();
}

function resumePreview() {
  previewSuspended = false;
}

function resetPreviewLatencyEstimate() {
  // Retained for API compatibility — Rust now owns scheduling latency.
}

// ── Viewport math ───────────────────────────────────────────────────────────

function getViewportFitRef(): FitReference {
  return selectedLayerIsCrop() ? fullCanvasCrop() : getCommittedCropRect();
}

function getViewportFitScale(): number {
  const fit = getViewportFitRef();
  const { viewportScreenWidth: w, viewportScreenHeight: h } = state;
  if (w <= 0 || h <= 0 || fit.width <= 0 || fit.height <= 0) return 1;
  return computeFitScale({ width: w, height: h }, fit);
}

function getViewportZoomPercent(): number | null {
  const { viewportScreenWidth: w, viewportScreenHeight: h } = state;
  if (w <= 0 || h <= 0) return null;
  const fit = getViewportFitRef();
  if (fit.width <= 0 || fit.height <= 0) return null;
  return Math.round(
    computeFitScale({ width: w, height: h }, fit) * state.viewportZoom * 100,
  );
}

function getMaxViewportZoom(): number {
  return Math.max(1, MAX_IMAGE_SCALE / getViewportFitScale());
}

function fitPreviewSize(
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

function getViewportDisplaySize() {
  const fit = getViewportFitRef();
  return fitPreviewSize(
    state.viewportScreenWidth,
    state.viewportScreenHeight,
    fit.width,
    fit.height,
  );
}

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
  const previewFrame = await imageBridge.renderPreview({
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
  if (
    previewSpec.crop.x <= 0 &&
    previewSpec.crop.y <= 0 &&
    previewSpec.crop.width >= state.canvasWidth &&
    previewSpec.crop.height >= state.canvasHeight
  ) {
    return;
  }
  const backdropFrame = await imageBridge.renderPreview({
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
  const generation = imageBridge.nextGeneration();
  imageBridge.sendPreviewViewports({
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
  if (ensurePlatformDetected()) {
    await tauriRefresh(quality);
  } else {
    await browserRefresh(quality);
  }
}

function refreshPreview() {
  const quality: PreviewQuality = isAdjustmentSliderActive() ? "interactive" : "final";
  return dispatchRefresh(quality);
}

function refreshFinalPreview() {
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

// ── Viewport commands ───────────────────────────────────────────────────────

function setViewportScreenSize(width: number, height: number) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === state.viewportScreenWidth && h === state.viewportScreenHeight) return;
  setState({ viewportScreenWidth: w, viewportScreenHeight: h });
  void refreshPreview();
}

function resetViewport() {
  const fit = getViewportFitRef();
  setState({
    viewportZoom: 1,
    viewportCenterX: fit.x + fit.width * 0.5,
    viewportCenterY: fit.y + fit.height * 0.5,
  });
  void refreshFinalPreview();
}

function zoomViewport(delta: number, pinch: boolean, anchorX: number, anchorY: number) {
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
  void dispatchRefresh("interactive");
  debounceFinalPreviewRefresh();
}

function panViewport(deltaX: number, deltaY: number, shouldRefresh = true) {
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

function offsetViewportCenter(deltaX: number, deltaY: number) {
  setState({
    viewportCenterX: state.viewportCenterX + deltaX,
    viewportCenterY: state.viewportCenterY + deltaY,
  });
  void refreshPreview();
}

function setViewportState(params: { centerX?: number; centerY?: number; zoom?: number }) {
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

// ── Image lifecycle ─────────────────────────────────────────────────────────

function createArtboardId() {
  return globalThis.crypto?.randomUUID?.() ?? `artboard-${Date.now()}-${Math.random()}`;
}

async function getImageDimensions(
  src: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("failed to load image"));
    image.src = src;
  });
}

function getNextArtboardWorldX() {
  const rightEdge = state.artboards.reduce(
    (max, artboard) => Math.max(max, artboard.worldX + artboard.width),
    0,
  );
  return state.artboards.length === 0 ? 0 : rightEdge + ARTBOARD_GAP;
}

function getArtboardTitle(source: ArtboardSource) {
  switch (source.kind) {
    case "path": {
      const segments = source.path.split(/[\\/]/);
      const name = segments[segments.length - 1];
      return name || source.path;
    }
    case "file":
      return source.file.name;
    case "peer":
      return source.picture.name;
    default:
      throw new Error("unknown artboard source");
  }
}

function beginLoadToken() {
  activeLoadToken += 1;
  return activeLoadToken;
}

function isActiveLoadToken(token: number) {
  return activeLoadToken === token;
}

function isSupersededImageLoadError(error: unknown) {
  return error instanceof Error && error.message === SUPERSEDED_IMAGE_LOAD_ERROR;
}

function describeImageLoadError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isWebGpuAdapterError(message: string) {
  return message.includes("No suitable wgpu adapter found");
}

async function cloneBlobUrl(url: string) {
  if (!url.startsWith("blob:")) return url;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to clone blob url: ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function getPendingArtboardSize() {
  const selectedArtboard = state.artboards.find(
    (artboard) => artboard.id === state.selectedArtboardId,
  );
  if (selectedArtboard && selectedArtboard.width > 0 && selectedArtboard.height > 0) {
    return { width: selectedArtboard.width, height: selectedArtboard.height };
  }
  if (state.canvasWidth > 0 && state.canvasHeight > 0) {
    return { width: state.canvasWidth, height: state.canvasHeight };
  }
  return {
    width: DEFAULT_PENDING_ARTBOARD_WIDTH,
    height: DEFAULT_PENDING_ARTBOARD_HEIGHT,
  };
}

function artboardSourceMatches(a: ArtboardSource, b: ArtboardSource) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "path":
      return a.path === (b as ArtboardSource & { kind: "path" }).path;
    case "file": {
      const other = b as ArtboardSource & { kind: "file" };
      return (
        a.file.name === other.file.name &&
        a.file.size === other.file.size &&
        a.file.lastModified === other.file.lastModified
      );
    }
    case "peer": {
      const other = b as ArtboardSource & { kind: "peer" };
      return (
        a.peerEndpointId === other.peerEndpointId && a.picture.id === other.picture.id
      );
    }
    default:
      throw new Error("unknown artboard source");
  }
}

async function focusExistingArtboard(artboardId: string) {
  if (artboardId !== state.selectedArtboardId) {
    await selectArtboard(artboardId);
    return;
  }
  setState("currentView", "editor");
  resetViewport();
}

function resetViewportStateForArtboard(
  canvasWidth: number,
  canvasHeight: number,
  preserveViewport: boolean = false,
) {
  const crop = fullCanvasCrop(canvasWidth, canvasHeight);
  if (preserveViewport) {
    setState({ canvasWidth, canvasHeight, crop, cropDraft: null, isCropMode: false });
  } else {
    setState({
      canvasWidth,
      canvasHeight,
      viewportZoom: 1,
      viewportCenterX: crop.width * 0.5,
      viewportCenterY: crop.height * 0.5,
      crop,
      cropDraft: null,
      isCropMode: false,
    });
  }
}

function clearLoadedImageState() {
  resumePreview();
  resetPreviewLatencyEstimate();
  clearPreviewTiles();
  setState({
    artboards: [],
    selectedArtboardId: null,
    layers: [],
    canvasWidth: 0,
    canvasHeight: 0,
    selectedLayerIdx: -1,
    selectedLayerPart: "layer",
    viewportZoom: 1,
    viewportCenterX: 0,
    viewportCenterY: 0,
    previewRenderWidth: 0,
    previewRenderHeight: 0,
    previewContentVersion: 0,
    previewDisplayColorSpace: "Unknown",
    sourceBitDepth: "Unknown",
    crop: { x: 0, y: 0, width: 0, height: 0, rotation: 0 },
    cropDraft: null,
    isCropMode: false,
    loadError: null,
  });
}

function setPendingEditorState(
  artboardId: string,
  canvasWidth: number,
  canvasHeight: number,
  sourceBitDepth: string,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
    fingerprint: string | null;
    rating: number | null;
    baseRating: number | null;
  } | null,
  loadingMediaSrc: string | null,
  preserveViewport: boolean = false,
) {
  suspendPreview();
  resetViewportStateForArtboard(canvasWidth, canvasHeight, preserveViewport);
  setState({
    currentView: "editor",
    selectedArtboardId: artboardId,
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    layers: [],
    selectedLayerIdx: -1,
    selectedLayerPart: "layer",
    sourceBitDepth,
    previewContentVersion: 0,
    previewDisplayColorSpace: "Unknown",
    isLoading: true,
    loadingMediaSrc,
    loadError: null,
  });
}

async function loadArtboardSource(source: ArtboardSource) {
  switch (source.kind) {
    case "path":
      return imageBridge.openImage(source.path);
    case "file":
      return imageBridge.openImageFile(source.file);
    case "peer":
      return imageBridge.openPeerImage(source.peerEndpointId, source.picture);
    default:
      throw new Error("unknown artboard source");
  }
}

async function loadArtboardIntoEditor(artboard: ArtboardState) {
  const loadToken = beginLoadToken();
  const previousArtboard = state.artboards.find(
    (candidate) => candidate.id === state.selectedArtboardId,
  );
  const preserveViewport = previousArtboard !== undefined;
  setPendingEditorState(
    artboard.id,
    artboard.width,
    artboard.height,
    artboard.sourceBitDepth,
    artboard.activeMediaLibraryId && artboard.activeMediaItemId
      ? {
          libraryId: artboard.activeMediaLibraryId,
          itemId: artboard.activeMediaItemId,
          fingerprint: artboard.activeFingerprint,
          rating: artboard.activeMediaRating,
          baseRating: artboard.activeMediaBaseRating,
        }
      : null,
    null,
    preserveViewport,
  );
  if (preserveViewport && previousArtboard) {
    setState(
      "viewportCenterX",
      (prev) => prev + previousArtboard.worldX - artboard.worldX,
    );
    setState(
      "viewportCenterY",
      (prev) => prev + previousArtboard.worldY - artboard.worldY,
    );
  }
  try {
    const info = await loadArtboardSource(artboard.source);
    if (!isActiveLoadToken(loadToken)) return;
    resetPreviewLatencyEstimate();
    clearPreviewTiles();
    setState("artboards", (candidate) => candidate.id === artboard.id, {
      ...artboard,
      width: info.canvas_width,
      height: info.canvas_height,
      sourceBitDepth: info.source_bit_depth,
      activeFingerprint: info.fingerprint ?? artboard.activeFingerprint,
      previewTile: null,
      backdropTile: null,
    });
    resetViewportStateForArtboard(
      info.canvas_width,
      info.canvas_height,
      preserveViewport,
    );
    setState({ sourceBitDepth: info.source_bit_depth });
    await useLayerStack().refresh();
    if (artboard.source.kind === "path") {
      const restored = await imageBridge.restoreCurrentBrowserSnapshot(
        artboard.source.path,
      );
      if (restored) {
        await useLayerStack().refresh();
      }
    }
    resetHistory();
    resumePreview();
    await refreshPreview();
  } catch (error) {
    if (!isActiveLoadToken(loadToken) || isSupersededImageLoadError(error)) return;
    throw error;
  } finally {
    if (isActiveLoadToken(loadToken)) {
      setState({ isLoading: false, loadingMediaSrc: null });
    }
  }
}

async function openImageFrom(
  load: () => Promise<{
    canvas_width: number;
    canvas_height: number;
    source_bit_depth: string;
    fingerprint: string | null;
  }>,
  source: ArtboardSource,
  loadingMediaSrc: string | null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
    fingerprint: string | null;
    rating: number | null;
    baseRating: number | null;
  } | null,
  mode: OpenImageMode,
) {
  const ownedLoadingMediaSrc = loadingMediaSrc
    ? await cloneBlobUrl(loadingMediaSrc)
    : null;
  const existingArtboard = state.artboards.find((artboard) =>
    artboardSourceMatches(artboard.source, source),
  );
  if (existingArtboard) {
    if (ownedLoadingMediaSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(ownedLoadingMediaSrc);
    }
    await focusExistingArtboard(existingArtboard.id);
    return;
  }
  const replacementArtboard =
    mode === "replace"
      ? (state.artboards.find((artboard) => artboard.id === state.selectedArtboardId) ??
        null)
      : null;
  const previousSelectedArtboardId = state.selectedArtboardId;
  let pendingSize: { width: number; height: number };
  if (mode === "replace" && ownedLoadingMediaSrc) {
    try {
      const dims = await getImageDimensions(ownedLoadingMediaSrc);
      pendingSize = dims;
    } catch {
      pendingSize = {
        width: DEFAULT_PENDING_ARTBOARD_WIDTH,
        height: DEFAULT_PENDING_ARTBOARD_HEIGHT,
      };
    }
  } else if (mode === "replace") {
    pendingSize = {
      width: DEFAULT_PENDING_ARTBOARD_WIDTH,
      height: DEFAULT_PENDING_ARTBOARD_HEIGHT,
    };
  } else {
    pendingSize = getPendingArtboardSize();
  }
  const artboardId = replacementArtboard?.id ?? createArtboardId();
  const artboard = {
    id: artboardId,
    title: getArtboardTitle(source),
    worldX: replacementArtboard?.worldX ?? getNextArtboardWorldX(),
    worldY: replacementArtboard?.worldY ?? 0,
    width: pendingSize.width,
    height: pendingSize.height,
    sourceBitDepth: "Loading",
    source,
    activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
    activeMediaItemId: activeMediaSelection?.itemId ?? null,
    activeFingerprint: activeMediaSelection?.fingerprint ?? null,
    activeMediaRating: activeMediaSelection?.rating ?? null,
    activeMediaBaseRating: activeMediaSelection?.baseRating ?? null,
    previewTile: null,
    backdropTile: null,
  };
  const loadToken = beginLoadToken();
  if (replacementArtboard) {
    setState("artboards", (artboards) =>
      artboards.filter((a) => a.id !== replacementArtboard.id),
    );
  }
  setState("artboards", (artboards) => [...artboards, artboard]);
  setPendingEditorState(
    artboard.id,
    pendingSize.width,
    pendingSize.height,
    "Loading",
    activeMediaSelection,
    ownedLoadingMediaSrc,
  );
  try {
    if (source.kind === "path") {
      await imageBridge.prepareImageOpen(source.path);
    }
    const info = await load();
    if (!isActiveLoadToken(loadToken)) return;
    resetPreviewLatencyEstimate();
    clearPreviewTiles();
    setState("artboards", (candidate) => candidate.id === artboard.id, {
      ...artboard,
      title: getArtboardTitle(source),
      width: info.canvas_width,
      height: info.canvas_height,
      sourceBitDepth: info.source_bit_depth,
      source,
      activeMediaLibraryId: activeMediaSelection?.libraryId ?? null,
      activeMediaItemId: activeMediaSelection?.itemId ?? null,
      activeFingerprint: info.fingerprint ?? activeMediaSelection?.fingerprint ?? null,
      activeMediaRating: activeMediaSelection?.rating ?? null,
      activeMediaBaseRating: activeMediaSelection?.baseRating ?? null,
      previewTile: null,
      backdropTile: null,
    });
    resetViewportStateForArtboard(info.canvas_width, info.canvas_height);
    setState({ sourceBitDepth: info.source_bit_depth });
    await useLayerStack().refresh();
    if (source.kind === "path") {
      const restored = await imageBridge.restoreCurrentBrowserSnapshot(source.path);
      if (restored) {
        await useLayerStack().refresh();
      }
    }
    resetHistory();
    resumePreview();
    await refreshPreview();
  } catch (error) {
    if (!isActiveLoadToken(loadToken) || isSupersededImageLoadError(error)) return;
    const message = describeImageLoadError(error);
    setState({
      loadError: message,
      ...(isWebGpuAdapterError(message)
        ? {
            webgpuAvailable: false,
            webgpuReason: "No suitable WebGPU adapter found",
          }
        : {}),
    });
    if (replacementArtboard) {
      await loadArtboardIntoEditor(replacementArtboard);
      throw error;
    }
    setState("artboards", (artboards) =>
      artboards.filter((candidate) => candidate.id !== artboard.id),
    );
    if (
      previousSelectedArtboardId &&
      state.artboards.some((candidate) => candidate.id === previousSelectedArtboardId)
    ) {
      await selectArtboard(previousSelectedArtboardId);
    } else {
      closeImage();
    }
    throw error;
  } finally {
    if (ownedLoadingMediaSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(ownedLoadingMediaSrc);
    }
    if (isActiveLoadToken(loadToken)) {
      setState({ isLoading: false, loadingMediaSrc: null });
    }
  }
}

function closeImage() {
  beginLoadToken();
  clearLoadedImageState();
  setState({
    currentView: "media",
    activeMediaLibraryId: null,
    activeMediaItemId: null,
    isLoading: false,
    loadingMediaSrc: null,
  });
}

async function closeArtboard(artboardId: string) {
  const artboardIndex = state.artboards.findIndex(
    (candidate) => candidate.id === artboardId,
  );
  if (artboardIndex < 0) {
    throw new Error("artboard not found");
  }
  const remainingArtboards = state.artboards.filter(
    (candidate) => candidate.id !== artboardId,
  );
  if (remainingArtboards.length === 0) {
    closeImage();
    return;
  }
  if (state.selectedArtboardId !== artboardId) {
    setState("artboards", remainingArtboards);
    return;
  }
  beginLoadToken();
  const nextArtboard =
    remainingArtboards[Math.min(artboardIndex, remainingArtboards.length - 1)];
  clearPreviewTiles();
  setState({
    artboards: remainingArtboards,
    selectedArtboardId: null,
    isLoading: false,
    loadingMediaSrc: null,
  });
  await selectArtboard(nextArtboard.id);
}

async function openImage(
  path: string,
  loadingMediaSrc: string | null = null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
    fingerprint: string | null;
    rating: number | null;
    baseRating: number | null;
  } | null = null,
  mode: OpenImageMode = "replace",
) {
  const isS3 = path.startsWith("s3://");
  if (isS3) {
    setState("isDownloading", true);
  }
  let unlistenPhase: (() => void) | null = null;
  if (isS3) {
    unlistenPhase = imageBridge.onImageOpenPhase((phase) => {
      if (phase === "processing") {
        setState("isDownloading", false);
      }
    });
  }
  try {
    await openImageFrom(
      () => imageBridge.openImage(path),
      { kind: "path", path },
      loadingMediaSrc,
      activeMediaSelection,
      mode,
    );
  } finally {
    unlistenPhase?.();
    setState("isDownloading", false);
  }
}

async function openImageFile(file: File, mode: OpenImageMode = "replace") {
  await openImageFrom(
    () => imageBridge.openImageFile(file),
    { kind: "file", file },
    null,
    null,
    mode,
  );
}

async function openPeerImage(
  peerEndpointId: string,
  picture: SharedPicture,
  loadingMediaSrc: string | null = null,
  activeMediaSelection: {
    libraryId: string;
    itemId: string;
    fingerprint: string | null;
    rating: number | null;
    baseRating: number | null;
  } | null = null,
  mode: OpenImageMode = "replace",
) {
  await openImageFrom(
    () => imageBridge.openPeerImage(peerEndpointId, picture),
    { kind: "peer", peerEndpointId, picture },
    loadingMediaSrc,
    activeMediaSelection,
    mode,
  );
}

async function selectArtboard(artboardId: string) {
  if (artboardId === state.selectedArtboardId) return;
  const artboard = state.artboards.find((candidate) => candidate.id === artboardId);
  if (!artboard) {
    throw new Error("artboard not found");
  }
  await loadArtboardIntoEditor(artboard);
}

async function exportImage(path: string) {
  setState("loadError", null);
  try {
    await imageBridge.exportImage(path);
  } catch (error) {
    setState("loadError", describeImageLoadError(error));
  }
}

function pickExportTarget() {
  return imageBridge.pickExportTarget();
}

// ── Composable surface ─────────────────────────────────────────────────────

export function useOpenImage(): {
  previewTile: Accessor<RenderedTile | null>;
  backdropTile: Accessor<RenderedTile | null>;
  open: typeof openImage;
  openFile: typeof openImageFile;
  openPeer: typeof openPeerImage;
  close: typeof closeImage;
  closeArtboard: typeof closeArtboard;
  selectArtboard: typeof selectArtboard;
  exportTo: typeof exportImage;
  pickExportTarget: typeof pickExportTarget;
  refreshPreview: typeof refreshPreview;
  refreshFinalPreview: typeof refreshFinalPreview;
  clearPreviewTiles: typeof clearPreviewTiles;
  suspendPreview: typeof suspendPreview;
  resumePreview: typeof resumePreview;
  resetPreviewLatencyEstimate: typeof resetPreviewLatencyEstimate;
  setViewportScreenSize: typeof setViewportScreenSize;
  resetViewport: typeof resetViewport;
  zoomViewport: typeof zoomViewport;
  panViewport: typeof panViewport;
  offsetViewportCenter: typeof offsetViewportCenter;
  setViewportState: typeof setViewportState;
  getViewportFitRef: typeof getViewportFitRef;
  getViewportFitScale: typeof getViewportFitScale;
  getViewportZoomPercent: typeof getViewportZoomPercent;
  getMaxViewportZoom: typeof getMaxViewportZoom;
  getViewportDisplaySize: typeof getViewportDisplaySize;
  fitPreviewSize: typeof fitPreviewSize;
} {
  return {
    previewTile,
    backdropTile,
    open: openImage,
    openFile: openImageFile,
    openPeer: openPeerImage,
    close: closeImage,
    closeArtboard,
    selectArtboard,
    exportTo: exportImage,
    pickExportTarget,
    refreshPreview,
    refreshFinalPreview,
    clearPreviewTiles,
    suspendPreview,
    resumePreview,
    resetPreviewLatencyEstimate,
    setViewportScreenSize,
    resetViewport,
    zoomViewport,
    panViewport,
    offsetViewportCenter,
    setViewportState,
    getViewportFitRef,
    getViewportFitScale,
    getViewportZoomPercent,
    getMaxViewportZoom,
    getViewportDisplaySize,
    fitPreviewSize,
  };
}
