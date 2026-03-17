import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  applyEdit,
  applyGradientMask,
  getCommittedCropRect,
  getPreviewZoomPercent,
  state,
  isDrawerOpen,
  openImageFile,
  panPreview,
  previewContextFrame,
  previewFrame,
  resetPreviewViewport,
  setPreviewViewportSize,
  zoomPreviewDelta,
} from "../store/editor";
import type { MaskParamsInfo } from "../bridge/index";

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

interface ImageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

const HANDLE_SIZE = 10;

function getDisplayBounds(
  stageWidth: number,
  stageHeight: number,
  crop = {
    x: 0,
    y: 0,
    width: state.canvasWidth,
    height: state.canvasHeight,
  },
): ImageBounds {
  if (stageWidth <= 0 || stageHeight <= 0 || crop.width <= 0 || crop.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale =
    Math.min(stageWidth / crop.width, stageHeight / crop.height) * state.previewZoom;
  return {
    x: stageWidth * 0.5 - (state.previewCenterX - crop.x) * scale,
    y: stageHeight * 0.5 - (state.previewCenterY - crop.y) * scale,
    width: crop.width * scale,
    height: crop.height * scale,
    scale,
  };
}

function getFullImageBounds(stageWidth: number, stageHeight: number): ImageBounds {
  if (
    stageWidth <= 0 ||
    stageHeight <= 0 ||
    state.canvasWidth <= 0 ||
    state.canvasHeight <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(
    stageWidth / state.canvasWidth,
    stageHeight / state.canvasHeight,
  );
  return {
    x: (stageWidth - state.canvasWidth * scale) * 0.5,
    y: (stageHeight - state.canvasHeight * scale) * 0.5,
    width: state.canvasWidth * scale,
    height: state.canvasHeight * scale,
    scale,
  };
}

const Canvas: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let stageRef: HTMLDivElement | undefined;
  let viewportRef: HTMLDivElement | undefined;
  let scratchCanvas: HTMLCanvasElement | undefined;
  let contextCanvas: HTMLCanvasElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  const [draftCrop, setDraftCrop] = createSignal<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  } | null>(null);
  const [draftMask, setDraftMask] = createSignal<MaskParamsInfo | null>(null);
  const activePointers = new Map<number, { x: number; y: number }>();
  let gesture:
    | { kind: "pan"; x: number; y: number }
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

  const shouldShowZoomIndicator = () => state.previewZoom > 1.001 || state.previewZoom < 0.999;
  const previewZoomPercent = () => getPreviewZoomPercent();

  const activeMask = (): MaskParamsInfo | null => draftMask() ?? selectedMaskParams();

  function maskHandleAtPoint(sx: number, sy: number): MaskHandle | null {
    if (!stageRef) return null;
    const mp = activeMask();
    if (!mp) return null;
    const crop = getCommittedCropRect();
    const bounds = getDisplayBounds(stageRef.clientWidth, stageRef.clientHeight, crop);
    if (bounds.scale <= 0) return null;

    const toScreen = (canvasX: number, canvasY: number) => ({
      x: bounds.x + (canvasX - crop.x) * bounds.scale,
      y: bounds.y + (canvasY - crop.y) * bounds.scale,
    });

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
    _cssWidth: number,
    _cssHeight: number,
  ) {
    if (!stageRef) return;
    const mp = activeMask();
    if (!mp) return;
    const crop = getCommittedCropRect();
    const bounds = getDisplayBounds(stageRef.clientWidth, stageRef.clientHeight, crop);
    if (bounds.scale <= 0) return;

    const toScreen = (canvasX: number, canvasY: number) => ({
      x: bounds.x + (canvasX - crop.x) * bounds.scale,
      y: bounds.y + (canvasY - crop.y) * bounds.scale,
    });

    ctx.save();

    const drawHandle = (x: number, y: number, filled: boolean) => {
      // Black border for visibility on light images
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      // White handle
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

      // Line between handles — black shadow then white
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
      const r = (mp.radius ?? 0) * bounds.scale;

      // Circle outline — black shadow then white
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
    const bounds = getFullImageBounds(stageRef.clientWidth, stageRef.clientHeight);
    if (bounds.scale <= 0) return null;
    const draft = activeCrop();
    if (!draft) return null;
    const cx = bounds.x + (draft.x + draft.width * 0.5) * bounds.scale;
    const cy = bounds.y + (draft.y + draft.height * 0.5) * bounds.scale;
    const cos = Math.cos(-draft.rotation);
    const sin = Math.sin(-draft.rotation);
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * cos - dy * sin + cx;
    const ly = dx * sin + dy * cos + cy;
    // Rotate handle: 30px above top-center
    const rotHandleX = cx;
    const rotHandleY = cy - (draft.height * 0.5) * bounds.scale - 30;
    // Check rotate handle in unrotated space (rotate the handle position back)
    const rhDx = rotHandleX - cx;
    const rhDy = rotHandleY - cy;
    const rhScreenX = cx + rhDx * Math.cos(draft.rotation) - rhDy * Math.sin(draft.rotation);
    const rhScreenY = cy + rhDx * Math.sin(draft.rotation) + rhDy * Math.cos(draft.rotation);
    if (Math.hypot(x - rhScreenX, y - rhScreenY) <= HANDLE_SIZE + 4) return "rotate" as CropHandle;
    const left = bounds.x + draft.x * bounds.scale;
    const top = bounds.y + draft.y * bounds.scale;
    const right = left + draft.width * bounds.scale;
    const bottom = top + draft.height * bounds.scale;
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
    if (!stageRef || !selectedCropLayer()) return;
    const bounds = getFullImageBounds(stageRef.clientWidth, stageRef.clientHeight);
    if (bounds.scale <= 0) return;
    const draft = activeCrop();
    if (!draft) return;
    const width = draft.width * bounds.scale;
    const height = draft.height * bounds.scale;
    const cx = bounds.x + (draft.x + draft.width * 0.5) * bounds.scale;
    const cy = bounds.y + (draft.y + draft.height * 0.5) * bounds.scale;
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

  function drawFrame() {
    if (!canvasRef || !viewportRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    const cssWidth = Math.max(1, Math.floor(viewportRef.clientWidth));
    const cssHeight = Math.max(1, Math.floor(viewportRef.clientHeight));
    const devicePixelRatio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * devicePixelRatio));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * devicePixelRatio));
    if (canvasRef.width !== pixelWidth || canvasRef.height !== pixelHeight) {
      canvasRef.width = pixelWidth;
      canvasRef.height = pixelHeight;
    }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const cropLayer = selectedCropLayer();
    const previewBounds = cropLayer
      ? { x: 0, y: 0, width: state.canvasWidth, height: state.canvasHeight }
      : getCommittedCropRect();
    const imageBounds = cropLayer
      ? getFullImageBounds(cssWidth, cssHeight)
      : getDisplayBounds(cssWidth, cssHeight, previewBounds);
    const contextFrame = previewContextFrame();
    if (contextFrame) {
      contextCanvas ??= document.createElement("canvas");
      if (
        contextCanvas.width !== contextFrame.width ||
        contextCanvas.height !== contextFrame.height
      ) {
        contextCanvas.width = contextFrame.width;
        contextCanvas.height = contextFrame.height;
      }
      const contextScratch = contextCanvas.getContext("2d");
      if (!contextScratch) {
        throw new Error("context canvas 2d context is required");
      }
      contextScratch.putImageData(contextFrame, 0, 0);
      ctx.drawImage(
        contextCanvas,
        imageBounds.x,
        imageBounds.y,
        imageBounds.width,
        imageBounds.height,
      );
    }
    const frame = previewFrame();
    if (frame && !cropLayer) {
      scratchCanvas ??= document.createElement("canvas");
      if (
        scratchCanvas.width !== frame.image.width ||
        scratchCanvas.height !== frame.image.height
      ) {
        scratchCanvas.width = frame.image.width;
        scratchCanvas.height = frame.image.height;
      }
      const scratchContext = scratchCanvas.getContext("2d");
      if (!scratchContext) {
        throw new Error("scratch canvas 2d context is required");
      }
      scratchContext.putImageData(frame.image, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        scratchCanvas,
        imageBounds.x + (frame.crop.x - previewBounds.x) * imageBounds.scale,
        imageBounds.y + (frame.crop.y - previewBounds.y) * imageBounds.scale,
        frame.crop.width * imageBounds.scale,
        frame.crop.height * imageBounds.scale,
      );
    }
    drawCropOverlay(ctx, cssWidth, cssHeight);
    drawMaskOverlay(ctx, cssWidth, cssHeight);
  }

  createEffect(() => {
    state.previewViewportWidth;
    state.previewViewportHeight;
    state.previewZoom;
    state.previewCenterX;
    state.previewCenterY;
    state.selectedLayerIdx;
    state.layers;
    previewContextFrame();
    previewFrame();
    drawFrame();
  });

  createEffect(() => {
    const cropLayer = selectedCropLayer();
    setDraftCrop(cropLayer?.crop ?? null);
  });

  onMount(() => {
    const viewport = viewportRef;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setPreviewViewportSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
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
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      await openImageFile(file);
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (selectedCropLayer()) return;
    e.preventDefault();
    if (!stageRef) {
      throw new Error("preview stage is required for wheel zoom");
    }
    const deltaModeScale =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (stageRef?.clientHeight ?? 1)
          : 1;
    const delta = e.deltaY * deltaModeScale;
    const rect = stageRef.getBoundingClientRect();
    zoomPreviewDelta(delta, e.ctrlKey, e.clientX - rect.left, e.clientY - rect.top);
    drawFrame();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!stageRef) {
      throw new Error("preview stage is required for pointer interaction");
    }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (selectedCropLayer()) {
      const rect = stageRef.getBoundingClientRect();
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
    // Mask handle interaction
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
      const [p1, p2] = [...activePointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      gesture = { kind: "pinch", dist, midX, midY };
      return;
    }
    gesture = { kind: "pan", x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!stageRef) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      panPreview(dx, dy);
      drawFrame();
      gesture = { kind: "pan", x: e.clientX, y: e.clientY };
      return;
    }
    if (gesture.kind === "pinch") {
      if (activePointers.size >= 2) {
        const [p1, p2] = [...activePointers.values()];
        const newDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const newMidX = (p1.x + p2.x) / 2;
        const newMidY = (p1.y + p2.y) / 2;
        const rect = stageRef.getBoundingClientRect();
        // Derive delta so that zoomFactor == newDist/prevDist with pinch sensitivity 0.0005
        const delta = -Math.log(newDist / gesture.dist) / 0.0005;
        zoomPreviewDelta(delta, true, newMidX - rect.left, newMidY - rect.top);
        panPreview(newMidX - gesture.midX, newMidY - gesture.midY);
        gesture = { kind: "pinch", dist: newDist, midX: newMidX, midY: newMidY };
        drawFrame();
      }
      return;
    }
    if (gesture.kind === "mask") {
      const crop = getCommittedCropRect();
      const bounds = getDisplayBounds(stageRef.clientWidth, stageRef.clientHeight, crop);
      if (bounds.scale <= 0) return;
      const dx = (e.clientX - gesture.startX) / bounds.scale;
      const dy = (e.clientY - gesture.startY) / bounds.scale;
      const p = gesture.params;
      let next: MaskParamsInfo;
      if (p.kind === "linear") {
        const sx = p.x1 ?? 0, sy = p.y1 ?? 0, ex = p.x2 ?? 0, ey = p.y2 ?? 0;
        if (gesture.handle === "start") {
          next = { ...p, x1: sx + dx, y1: sy + dy };
        } else {
          next = { ...p, x2: ex + dx, y2: ey + dy };
        }
      } else {
        const cx = p.cx ?? 0, cy = p.cy ?? 0, r = p.radius ?? 0;
        if (gesture.handle === "center") {
          next = { ...p, cx: cx + dx, cy: cy + dy };
        } else {
          // Edge handle: adjust radius based on distance from center
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
    const bounds = getFullImageBounds(stageRef.clientWidth, stageRef.clientHeight);
    if (bounds.scale <= 0) {
      throw new Error("crop mode requires visible image bounds");
    }
    const start = gesture.crop;
    if (gesture.handle === "rotate") {
      const cx = bounds.x + (start.x + start.width * 0.5) * bounds.scale;
      const cy = bounds.y + (start.y + start.height * 0.5) * bounds.scale;
      const rect = stageRef.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const angle = Math.atan2(mx - cx, -(my - cy));
      setDraftCrop({ ...start, rotation: angle });
      drawFrame();
      return;
    }
    // Project screen delta into crop-local axes
    const rawDx = (e.clientX - gesture.startX) / bounds.scale;
    const rawDy = (e.clientY - gesture.startY) / bounds.scale;
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
    if (
      (gesture?.kind === "crop" || gesture?.kind === "mask") &&
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
      if (activePointers.size === 1) {
        const [p] = [...activePointers.values()];
        gesture = { kind: "pan", x: p.x, y: p.y };
      } else {
        gesture = null;
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
          ref={viewportRef}
          class="relative flex h-full w-full items-center justify-center lg:h-full"
          style={{
            height: isDrawerOpen() ? "calc(100% - 30vh)" : undefined,
          }}
        >
          <canvas
            ref={canvasRef}
            width="800"
            height="600"
            onDblClick={() => resetPreviewViewport()}
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
              state.layers.length === 0 ? "opacity-0" : "opacity-100"
            }`}
          />
          {state.isLoading && state.loadingMediaSrc && !previewFrame() && (
            <div class="pointer-events-none absolute inset-0">
              <img
                src={state.loadingMediaSrc}
                alt=""
                class="absolute inset-0 h-full w-full object-contain"
                style={{ "view-transition-name": "active-media" }}
              />
              <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--canvas-highlight),_transparent_40%)]" />
              <div class="absolute inset-x-0 bottom-6 flex items-center justify-center">
                <span class="inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/55 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/82 backdrop-blur">
                  <span class="h-2 w-2 animate-pulse rounded-full bg-white" />
                  Loading
                </span>
              </div>
            </div>
          )}
          {selectedCropLayer() && activeCrop() && (
            <div class="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur">
              <span>Crop</span>
              <span class="text-white/35">
                {activeCrop()!.width} × {activeCrop()!.height}
                {Math.abs(activeCrop()!.rotation) > 0.001 && ` ${Math.round(activeCrop()!.rotation * 180 / Math.PI)}°`}
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
          {shouldShowZoomIndicator() && previewZoomPercent() !== null && (
            <button
              type="button"
              class="absolute bottom-4 left-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75 backdrop-blur transition hover:border-white/20 hover:bg-black/60"
              onClick={() => resetPreviewViewport()}
            >
              <span>Zoom</span>
              <span class="text-white/35">{previewZoomPercent()}%</span>
            </button>
          )}
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
                  Drop an image to start
                </div>
                <div class="mt-1 text-sm text-white/48">
                  Drag a photo into the stage or use the Open action in the top bar.
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

export default Canvas;
