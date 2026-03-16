import * as bridge from "../bridge/index";
import {
  clamp,
  fullCanvasCrop,
  getCommittedCropRect,
  previewContextFrame,
  setPreviewContextFrame,
  setPreviewFrame,
  selectedLayerIsCrop,
  setState,
  state,
} from "./editor-store";

type PreviewQuality = "interactive" | "final";

const INTERACTIVE_PREVIEW_SCALE = 0.33;
const INTERACTIVE_PREVIEW_DEBOUNCE_MS = 16;
const ZOOM_PREVIEW_DEBOUNCE_MS = 120;
const PREVIEW_REQUEST_THROTTLE_MS = 250;
const MIN_PREVIEW_ZOOM = 0.1;
const MAX_PREVIEW_IMAGE_SCALE = 8;
const PREVIEW_ZOOM_SNAP_LOG_EPSILON = 0.12;

let previewRefreshVersion = 0;
let previewRefreshQueued: { version: number; quality: PreviewQuality } | null = null;
let previewRefreshPromise: Promise<void> | null = null;
let previewRefreshInteractiveTimer: ReturnType<typeof setTimeout> | null = null;
let previewLastRequestStartedAt = 0;
let previewRefreshInteractiveWaiters: Array<{
  resolve: () => void;
  reject: (error: unknown) => void;
}> = [];

export function getPreviewBounds() {
  if (selectedLayerIsCrop()) {
    return fullCanvasCrop();
  }
  return getCommittedCropRect();
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

function getPreviewFitScale() {
  const bounds = getPreviewBounds();
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    state.previewViewportWidth <= 0 ||
    state.previewViewportHeight <= 0
  ) {
    return null;
  }
  const fitScale = Math.min(
    state.previewViewportWidth / bounds.width,
    state.previewViewportHeight / bounds.height,
  );
  if (fitScale <= 0) {
    throw new Error("preview fit scale must be positive");
  }
  return { bounds, fitScale };
}

function getPreviewCropSize(zoom: number) {
  const previewScale = getPreviewFitScale();
  if (!previewScale) {
    return { width: 0, height: 0 };
  }
  const imageScale = previewScale.fitScale * zoom;
  return {
    width: Math.min(previewScale.bounds.width, state.previewViewportWidth / imageScale),
    height: Math.min(
      previewScale.bounds.height,
      state.previewViewportHeight / imageScale,
    ),
  };
}

function clampPreviewCenter(zoom: number, centerX: number, centerY: number) {
  const { width: cropWidth, height: cropHeight } = getPreviewCropSize(zoom);
  const bounds = getPreviewBounds();
  return {
    x: clamp(
      centerX,
      bounds.x + cropWidth * 0.5,
      bounds.x + bounds.width - cropWidth * 0.5,
    ),
    y: clamp(
      centerY,
      bounds.y + cropHeight * 0.5,
      bounds.y + bounds.height - cropHeight * 0.5,
    ),
  };
}

function getVisiblePreview(zoom: number, centerX: number, centerY: number) {
  const previewScale = getPreviewFitScale();
  if (!previewScale) return null;
  const center = clampPreviewCenter(zoom, centerX, centerY);
  const imageScale = previewScale.fitScale * zoom;
  const imageX =
    state.previewViewportWidth * 0.5 - (center.x - previewScale.bounds.x) * imageScale;
  const imageY =
    state.previewViewportHeight * 0.5 - (center.y - previewScale.bounds.y) * imageScale;
  const screenLeft = Math.max(0, imageX);
  const screenTop = Math.max(0, imageY);
  const screenRight = Math.min(
    state.previewViewportWidth,
    imageX + previewScale.bounds.width * imageScale,
  );
  const screenBottom = Math.min(
    state.previewViewportHeight,
    imageY + previewScale.bounds.height * imageScale,
  );
  if (screenRight <= screenLeft || screenBottom <= screenTop) {
    throw new Error("visible preview must intersect the viewport");
  }
  return {
    viewportX: screenLeft,
    viewportY: screenTop,
    viewportWidth: screenRight - screenLeft,
    viewportHeight: screenBottom - screenTop,
    crop: {
      x: previewScale.bounds.x + (screenLeft - imageX) / imageScale,
      y: previewScale.bounds.y + (screenTop - imageY) / imageScale,
      width: (screenRight - screenLeft) / imageScale,
      height: (screenBottom - screenTop) / imageScale,
    },
    screenWidth: screenRight - screenLeft,
    screenHeight: screenBottom - screenTop,
  };
}

function getPreviewRequest(quality: PreviewQuality): bridge.PreviewRequest | null {
  const visible = getVisiblePreview(
    state.previewZoom,
    state.previewCenterX,
    state.previewCenterY,
  );
  if (!visible) return null;
  const devicePixelRatio =
    (window.devicePixelRatio || 1) *
    (quality === "interactive" ? INTERACTIVE_PREVIEW_SCALE : 1);
  return {
    target_width: Math.max(1, Math.round(visible.screenWidth * devicePixelRatio)),
    target_height: Math.max(1, Math.round(visible.screenHeight * devicePixelRatio)),
    crop: visible.crop,
    ignore_crop_layers: selectedLayerIsCrop(),
  };
}

function previewCropMatches(a: bridge.PreviewCrop, b: bridge.PreviewCrop) {
  const epsilon = 0.01;
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  );
}

function getContextPreviewRequest(quality: PreviewQuality): bridge.PreviewRequest | null {
  if (state.canvasWidth <= 0 || state.canvasHeight <= 0) return null;
  const crop = selectedLayerIsCrop() ? undefined : getCommittedCropRect();
  const devicePixelRatio =
    (window.devicePixelRatio || 1) *
    (quality === "interactive" ? INTERACTIVE_PREVIEW_SCALE : 1);
  const fitted = fitPreviewSize(
    state.previewViewportWidth * devicePixelRatio,
    state.previewViewportHeight * devicePixelRatio,
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

function toImageData(frame: bridge.PreviewFrame) {
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

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function renderPreviewThrottled(request: bridge.PreviewRequest) {
  const elapsed = Date.now() - previewLastRequestStartedAt;
  if (elapsed < PREVIEW_REQUEST_THROTTLE_MS) {
    await wait(PREVIEW_REQUEST_THROTTLE_MS - elapsed);
  }
  previewLastRequestStartedAt = Date.now();
  return bridge.renderPreview(request);
}

export function getPreviewDisplaySize() {
  const bounds = getPreviewBounds();
  return fitPreviewSize(
    state.previewViewportWidth,
    state.previewViewportHeight,
    bounds.width,
    bounds.height,
  );
}

export function getPreviewZoomPercent() {
  const previewScale = getPreviewFitScale();
  if (!previewScale) {
    return null;
  }
  return Math.round(previewScale.fitScale * state.previewZoom * 100);
}

export function getMaxPreviewZoom() {
  const previewScale = getPreviewFitScale();
  if (!previewScale) {
    return 1;
  }
  return Math.max(1, MAX_PREVIEW_IMAGE_SCALE / previewScale.fitScale);
}

function getPreviewSnapPoints(fitScale: number) {
  const snapPoints = [1, 1 / fitScale];
  return snapPoints.filter(
    (snapPoint, index) =>
      snapPoint >= MIN_PREVIEW_ZOOM &&
      snapPoint <= getMaxPreviewZoom() &&
      snapPoints.findIndex(
        (candidate) => Math.abs(candidate - snapPoint) <= Number.EPSILON,
      ) === index,
  );
}

function snapPreviewZoom(previousZoom: number, targetZoom: number, fitScale: number) {
  const nearestSnapPoint = getPreviewSnapPoints(fitScale).reduce<number | null>(
    (nearest, snapPoint) => {
      const crossedSnapPoint =
        (previousZoom < snapPoint && targetZoom > snapPoint) ||
        (previousZoom > snapPoint && targetZoom < snapPoint);
      const nearSnapPoint =
        Math.abs(Math.log(targetZoom / snapPoint)) <= PREVIEW_ZOOM_SNAP_LOG_EPSILON;
      if (!crossedSnapPoint && !nearSnapPoint) {
        return nearest;
      }
      if (nearest === null) {
        return snapPoint;
      }
      const currentDistance = Math.abs(Math.log(targetZoom / snapPoint));
      const nearestDistance = Math.abs(Math.log(targetZoom / nearest));
      return currentDistance < nearestDistance ? snapPoint : nearest;
    },
    null,
  );
  return nearestSnapPoint ?? targetZoom;
}

export function resetPreviewViewport() {
  const crop = getPreviewBounds();
  setState({
    previewZoom: 1,
    previewCenterX: crop.x + crop.width * 0.5,
    previewCenterY: crop.y + crop.height * 0.5,
  });
  void refreshPreview("viewport");
}

export function setPreviewViewportSize(width: number, height: number) {
  const nextWidth = Math.max(0, Math.floor(width));
  const nextHeight = Math.max(0, Math.floor(height));
  if (
    nextWidth === state.previewViewportWidth &&
    nextHeight === state.previewViewportHeight
  ) {
    return;
  }
  setState({
    previewViewportWidth: nextWidth,
    previewViewportHeight: nextHeight,
  });
  void refreshPreview("viewport");
}

export function zoomPreviewDelta(
  delta: number,
  pinch: boolean,
  anchorX: number,
  anchorY: number,
) {
  if (
    state.canvasWidth <= 0 ||
    state.canvasHeight <= 0 ||
    state.previewViewportWidth <= 0 ||
    state.previewViewportHeight <= 0
  ) {
    return;
  }
  const previewScale = getPreviewFitScale();
  if (!previewScale) {
    return;
  }
  const sensitivity = pinch ? 0.0005 : 0.001;
  const multiplier = Math.exp(-delta * sensitivity);
  const oldImageScale = previewScale.fitScale * state.previewZoom;
  const zoom = snapPreviewZoom(
    state.previewZoom,
    clamp(state.previewZoom * multiplier, MIN_PREVIEW_ZOOM, getMaxPreviewZoom()),
    previewScale.fitScale,
  );
  const newImageScale = previewScale.fitScale * zoom;
  const viewportCenterX = state.previewViewportWidth * 0.5;
  const viewportCenterY = state.previewViewportHeight * 0.5;
  const anchoredImageX =
    state.previewCenterX + (anchorX - viewportCenterX) / oldImageScale;
  const anchoredImageY =
    state.previewCenterY + (anchorY - viewportCenterY) / oldImageScale;
  const center = clampPreviewCenter(
    zoom,
    anchoredImageX - (anchorX - viewportCenterX) / newImageScale,
    anchoredImageY - (anchorY - viewportCenterY) / newImageScale,
  );
  setState({
    previewZoom: zoom,
    previewCenterX: center.x,
    previewCenterY: center.y,
  });
  void refreshPreview("zoom");
}

export function panPreview(deltaX: number, deltaY: number) {
  if (
    state.previewZoom <= 1 ||
    state.previewViewportWidth <= 0 ||
    state.previewViewportHeight <= 0
  ) {
    return;
  }
  const previewScale = getPreviewFitScale();
  if (!previewScale) {
    return;
  }
  const imageScale = previewScale.fitScale * state.previewZoom;
  const center = clampPreviewCenter(
    state.previewZoom,
    state.previewCenterX - deltaX / imageScale,
    state.previewCenterY - deltaY / imageScale,
  );
  setState({
    previewCenterX: center.x,
    previewCenterY: center.y,
  });
  void refreshPreview("viewport");
}

function performPreviewRefresh() {
  const queued = previewRefreshQueued;
  if (!queued) return Promise.resolve();
  previewRefreshQueued = null;
  const request = getPreviewRequest(queued.quality);
  const contextRequest = getContextPreviewRequest(queued.quality);
  if (!request || !contextRequest) return Promise.resolve();
  return renderPreviewThrottled(request).then(async (frame) => {
    if (queued.version !== previewRefreshVersion) return;
    if (frame.width === 0 || frame.height === 0) return;
    const crop = request.crop;
    if (!crop) {
      throw new Error("preview refresh requires a crop");
    }
    const currentVisible = getVisiblePreview(
      state.previewZoom,
      state.previewCenterX,
      state.previewCenterY,
    );
    if (!currentVisible) return;
    if (!previewCropMatches(crop, currentVisible.crop)) {
      void refreshPreview();
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
    setPreviewFrame({
      image: toImageData(frame),
      crop,
      viewportX: currentVisible.viewportX,
      viewportY: currentVisible.viewportY,
      viewportWidth: currentVisible.viewportWidth,
      viewportHeight: currentVisible.viewportHeight,
    });
    if (
      request.crop &&
      request.crop.width === state.canvasWidth &&
      request.crop.height === state.canvasHeight
    ) {
      setPreviewContextFrame(toImageData(frame));
      return;
    }
    if (queued.quality === "interactive" && previewContextFrame()) {
      return;
    }
    const contextFrame = await renderPreviewThrottled(contextRequest);
    if (queued.version !== previewRefreshVersion) return;
    if (contextFrame.width === 0 || contextFrame.height === 0) return;
    setPreviewContextFrame(toImageData(contextFrame));
  });
}

function queuePreviewRefresh(version: number, quality: PreviewQuality) {
  if (
    previewRefreshQueued &&
    previewRefreshQueued.version === version &&
    previewRefreshQueued.quality === "final"
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

function resolveInteractiveWaiters(work: Promise<void>) {
  const waiters = previewRefreshInteractiveWaiters;
  previewRefreshInteractiveWaiters = [];
  void work.then(
    () => {
      for (const waiter of waiters) {
        waiter.resolve();
      }
    },
    (error) => {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    },
  );
  return work;
}

function rejectInteractiveWaiters(error: unknown) {
  const waiters = previewRefreshInteractiveWaiters;
  previewRefreshInteractiveWaiters = [];
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

function scheduleRefresh(
  version: number,
  immediateInteractive: boolean,
  interactiveDelayMs: number,
) {
  if (previewRefreshInteractiveTimer !== null) {
    clearTimeout(previewRefreshInteractiveTimer);
    previewRefreshInteractiveTimer = null;
  }
  const completion = new Promise<void>((resolve, reject) => {
    previewRefreshInteractiveWaiters.push({ resolve, reject });
  });
  const runFinal = () => {
    previewRefreshInteractiveTimer = setTimeout(() => {
      previewRefreshInteractiveTimer = null;
      const work = queuePreviewRefresh(version, "final") ?? Promise.resolve();
      resolveInteractiveWaiters(work);
    }, INTERACTIVE_PREVIEW_DEBOUNCE_MS);
  };
  if (!immediateInteractive) {
    previewRefreshInteractiveTimer = setTimeout(() => {
      previewRefreshInteractiveTimer = null;
      const interactive =
        queuePreviewRefresh(version, "interactive") ?? Promise.resolve();
      const work = interactive.finally(() => {
        if (version !== previewRefreshVersion) return;
        return queuePreviewRefresh(version, "final") ?? Promise.resolve();
      });
      resolveInteractiveWaiters(work);
    }, interactiveDelayMs);
    return completion;
  }
  const interactive = queuePreviewRefresh(version, "interactive") ?? Promise.resolve();
  void interactive.then(
    () => {
      if (version !== previewRefreshVersion) return;
      runFinal();
    },
    (error) => {
      rejectInteractiveWaiters(error);
    },
  );
  return completion;
}

export function refreshPreview(
  mode: "progressive" | "viewport" | "zoom" | "final" = "progressive",
) {
  previewRefreshVersion += 1;
  const version = previewRefreshVersion;
  if (mode === "final") {
    if (previewRefreshInteractiveTimer !== null) {
      clearTimeout(previewRefreshInteractiveTimer);
      previewRefreshInteractiveTimer = null;
    }
    const work = queuePreviewRefresh(version, "final") ?? Promise.resolve();
    return resolveInteractiveWaiters(work);
  }
  if (mode === "viewport") {
    return scheduleRefresh(version, true, INTERACTIVE_PREVIEW_DEBOUNCE_MS);
  }
  if (mode === "zoom") {
    return scheduleRefresh(version, false, ZOOM_PREVIEW_DEBOUNCE_MS);
  }
  return scheduleRefresh(version, false, INTERACTIVE_PREVIEW_DEBOUNCE_MS);
}
