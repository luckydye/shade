import { Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  applyEdit,
  applyGradientMask,
  closeArtboard,
  getSelectedArtboard,
  getCommittedCropRect,
  getViewportZoomPercent,
  isDrawerOpen,
  moveArtboardBy,
  openImageFile,
  offsetViewportCenter,
  panViewport,
  backdropTile,
  previewTile,
  refreshPreview,
  resetViewport,
  selectArtboard,
  setViewportScreenSize,
  state,
  transitionMediaSrc,
  zoomViewport,
} from "../store/editor";
import { setMediaRating, type MaskParamsInfo } from "../bridge/index";
import { compositeArtboard } from "../viewport/compositor";
import { buildTransform, worldToScreen } from "../viewport/transform";
import { getViewportFitRef } from "../viewport/preview";
import type { WorldTransform } from "../viewport/transform";
import { setState, type ArtboardState } from "../store/editor-store";
import { Button } from "./Button";
import { MediaRating } from "./MediaRating";

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
  const [loadingArtboardImage, setLoadingArtboardImage] =
    createSignal<HTMLImageElement | null>(null);
  const [isSavingRating, setIsSavingRating] = createSignal(false);
  const activePointers = new Map<number, { x: number; y: number }>();
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
    | null = null;

  const selectedCropLayer = () => {
    const layer = state.layers[state.selectedLayerIdx];
    return layer?.kind === "crop" && layer.crop ? layer : null;
  };

  const activeCrop = () => draftCrop() ?? selectedCropLayer()?.crop ?? null;

  const selectedMaskParams = (): MaskParamsInfo | null => {
    const layer = state.layers[state.selectedLayerIdx];
    if (!layer?.has_mask || !layer.mask_params) return null;
    return layer.mask_params;
  };

  const shouldShowZoomIndicator = () =>
    state.viewportZoom > 1.001 || state.viewportZoom < 0.999;
  const viewportZoomPercent = () => getViewportZoomPercent();

  const activeMask = (): MaskParamsInfo | null => draftMask() ?? selectedMaskParams();
  const selectedArtboard = () => getSelectedArtboard();
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

  function maskHandleAtPoint(sx: number, sy: number): MaskHandle | null {
    if (!stageRef) return null;
    const mp = activeMask();
    if (!mp) return null;
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
    if (clickedArtboardClose) {
      setPressedArtboardChrome({
        kind: "close",
        artboardId: clickedArtboardClose.id,
      });
      return;
    }
    const clickedArtboardTitle = artboardTitleAtPoint(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const clickedArtboard = artboardAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (selectedCropLayer()) {
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
        tapArtboardId: clickedArtboard.id,
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
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
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
      const angle = Math.atan2(mx - center.x, -(my - center.y));
      setDraftCrop({ ...start, rotation: angle });
      drawFrame();
      return;
    }
    const rawDx = (e.clientX - gesture.startX) / t.scale;
    const rawDy = (e.clientY - gesture.startY) / t.scale;
    const cos = Math.cos(-start.rotation);
    const sin = Math.sin(-start.rotation);
    const deltaX = Math.round(rawDx * cos - rawDy * sin);
    const deltaY = Math.round(rawDx * sin + rawDy * cos);
    let next = start;
    switch (gesture.handle) {
      case "move":
        next = {
          ...start,
          x: Math.min(Math.max(0, start.x + deltaX), state.canvasWidth - start.width),
          y: Math.min(Math.max(0, start.y + deltaY), state.canvasHeight - start.height),
        };
        break;
      case "top-left":
        next = {
          ...start,
          x: start.x + deltaX,
          y: start.y + deltaY,
          width: start.width - deltaX,
          height: start.height - deltaY,
        };
        break;
      case "top":
        next = { ...start, y: start.y + deltaY, height: start.height - deltaY };
        break;
      case "top-right":
        next = {
          ...start,
          x: start.x,
          y: start.y + deltaY,
          width: start.width + deltaX,
          height: start.height - deltaY,
        };
        break;
      case "right":
        next = { ...start, width: start.width + deltaX };
        break;
      case "bottom-right":
        next = {
          ...start,
          width: start.width + deltaX,
          height: start.height + deltaY,
        };
        break;
      case "bottom":
        next = { ...start, height: start.height + deltaY };
        break;
      case "bottom-left":
        next = {
          ...start,
          x: start.x + deltaX,
          y: start.y,
          width: start.width - deltaX,
          height: start.height + deltaY,
        };
        break;
      case "left":
        next = {
          ...start,
          x: start.x + deltaX,
          y: start.y,
          width: start.width - deltaX,
          height: start.height,
        };
        break;
    }
    setDraftCrop({
      x: Math.max(0, next.x),
      y: Math.max(0, next.y),
      width: Math.max(1, next.width),
      height: Math.max(1, next.height),
      rotation: next.rotation,
    });
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
        void closeArtboard(pressedClose.artboardId);
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
        void selectArtboard(artboardId);
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
        void selectArtboard(tappedArtboardId);
      }
      return;
    }
    gesture = null;
  };

  return (
    <section class="relative flex min-h-[42vh] flex-1 overflow-hidden lg:min-h-0">
      <div
        ref={stageRef}
        class="relative flex-1 overflow-hidden bg-[var(--canvas-bg)]"
        style={{ "touch-action": "none" }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--canvas-highlight),_transparent_45%)]" />

        <div
          ref={containerRef}
          class="relative flex h-full w-full items-center justify-center lg:h-full"
          style={{
            height: isDrawerOpen() ? "calc(100% - 30vh)" : undefined,
          }}
        >
          <canvas
            ref={canvasRef}
            width="800"
            height="600"
            onDblClick={() => resetViewport()}
            style={{
              width: "100%",
              height: "100%",
              "view-transition-name":
                state.currentView === "editor" &&
                state.layers.length > 0 &&
                !state.isLoading
                  ? "active-editor-media"
                  : "none",
            }}
            class={`${
              state.artboards.length === 0 && !state.isLoading ? "opacity-0" : "opacity-100"
            }`}
          />
          {transitionMediaSrc() && (
            <div class="pointer-events-none absolute inset-0">
              <img
                src={transitionMediaSrc()!}
                alt=""
                class="absolute inset-0 h-full w-full object-contain"
                style={{
                  "view-transition-name": "active-media",
                }}
              />
              <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--canvas-highlight),_transparent_40%)]" />
            </div>
          )}
          {selectedCropLayer() && activeCrop() && (
            <div class="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur">
              <span>Crop</span>
              <span class="text-white/35">
                {activeCrop()!.width} × {activeCrop()!.height}
                {Math.abs(activeCrop()!.rotation) > 0.001 &&
                  ` ${Math.round((activeCrop()!.rotation * 180) / Math.PI)}°`}
              </span>
            </div>
          )}
          {activeMask() && (
            <div class="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur">
              <span>Mask</span>
              <span class="text-white/35">
                {activeMask()!.kind === "linear" ? "Linear" : "Radial"}
              </span>
            </div>
          )}
          {shouldShowZoomIndicator() && viewportZoomPercent() !== null && (
            <Button
              type="button"
              class="absolute bottom-4 left-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur transition hover:border-white/20 hover:bg-black/60"
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
