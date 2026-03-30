import type { CropRect } from "./store/editor-store";

export type CropAspectRatioPreset =
  | "free"
  | "original"
  | "1:1"
  | "2.35"
  | "2:1"
  | "1:2"
  | "4:5"
  | "5:4"
  | "3:2"
  | "2:3"
  | "16:9"
  | "9:16";

export type CropResizeHandle =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

export const CROP_ASPECT_RATIO_OPTIONS: readonly {
  value: CropAspectRatioPreset;
  label: string;
}[] = [
  { value: "free", label: "Free" },
  { value: "original", label: "Original" },
  { value: "1:1", label: "1:1" },
  { value: "2.35", label: "2.35" },
  { value: "2:1", label: "2:1" },
  { value: "1:2", label: "1:2" },
  { value: "4:5", label: "4:5" },
  { value: "5:4", label: "5:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundPositive(value: number) {
  return Math.max(1, Math.round(value));
}

export function resolveCropAspectRatio(
  preset: CropAspectRatioPreset,
  canvasWidth: number,
  canvasHeight: number,
) {
  switch (preset) {
    case "free":
      return null;
    case "original":
      if (canvasWidth <= 0 || canvasHeight <= 0) {
        return null;
      }
      return canvasWidth / canvasHeight;
    case "1:1":
      return 1;
    case "2.35":
      return 2.35;
    case "2:1":
      return 2;
    case "1:2":
      return 1 / 2;
    case "4:5":
      return 4 / 5;
    case "5:4":
      return 5 / 4;
    case "3:2":
      return 3 / 2;
    case "2:3":
      return 2 / 3;
    case "16:9":
      return 16 / 9;
    case "9:16":
      return 9 / 16;
    default:
      throw new Error(`unsupported crop aspect ratio preset: ${preset satisfies never}`);
  }
}

export function clampAspectSize(
  preferredWidth: number,
  preferredHeight: number,
  ratio: number,
  maxWidth: number,
  maxHeight: number,
  prefer: "width" | "height",
) {
  if (!(ratio > 0)) {
    throw new Error("crop aspect ratio must be positive");
  }
  const boundedMaxWidth = Math.max(1, Math.floor(maxWidth));
  const boundedMaxHeight = Math.max(1, Math.floor(maxHeight));
  const maxWidthByHeight = Math.max(1, Math.floor(boundedMaxHeight * ratio));
  const maxHeightByWidth = Math.max(1, Math.floor(boundedMaxWidth / ratio));

  if (prefer === "width") {
    const width = clamp(
      roundPositive(preferredWidth),
      1,
      Math.min(boundedMaxWidth, maxWidthByHeight),
    );
    const height = clamp(roundPositive(width / ratio), 1, boundedMaxHeight);
    return {
      width: clamp(roundPositive(height * ratio), 1, boundedMaxWidth),
      height,
    };
  }

  const height = clamp(
    roundPositive(preferredHeight),
    1,
    Math.min(boundedMaxHeight, maxHeightByWidth),
  );
  const width = clamp(roundPositive(height * ratio), 1, boundedMaxWidth);
  return {
    width,
    height: clamp(roundPositive(width / ratio), 1, boundedMaxHeight),
  };
}

export function fitCropRectToAspectRatio(
  crop: CropRect,
  ratio: number,
  canvasWidth: number,
  canvasHeight: number,
): CropRect {
  const prefer = crop.width / crop.height >= ratio ? "height" : "width";
  const { width, height } = clampAspectSize(
    crop.width,
    crop.height,
    ratio,
    crop.width,
    crop.height,
    prefer,
  );
  const centerX = crop.x + crop.width * 0.5;
  const centerY = crop.y + crop.height * 0.5;
  const x = clamp(Math.round(centerX - width * 0.5), 0, canvasWidth - width);
  const y = clamp(Math.round(centerY - height * 0.5), 0, canvasHeight - height);
  return {
    x,
    y,
    width,
    height,
    rotation: crop.rotation,
  };
}

function buildCropRectFromLocalEdges(
  start: CropRect,
  left: number,
  top: number,
  right: number,
  bottom: number,
  canvasWidth: number,
  canvasHeight: number,
): CropRect {
  if (!(right > left && bottom > top)) {
    throw new Error("crop edges must produce a positive rectangle");
  }
  const width = Math.min(canvasWidth, Math.max(1, right - left));
  const height = Math.min(canvasHeight, Math.max(1, bottom - top));
  const localCenterX = (left + right) * 0.5;
  const localCenterY = (top + bottom) * 0.5;
  const startCenterX = start.x + start.width * 0.5;
  const startCenterY = start.y + start.height * 0.5;
  const cos = Math.cos(start.rotation);
  const sin = Math.sin(start.rotation);
  const centerX = startCenterX + localCenterX * cos - localCenterY * sin;
  const centerY = startCenterY + localCenterX * sin + localCenterY * cos;
  return {
    x: clamp(centerX - width * 0.5, 0, canvasWidth - width),
    y: clamp(centerY - height * 0.5, 0, canvasHeight - height),
    width,
    height,
    rotation: start.rotation,
  };
}

export function resizeCropFromHandle(
  start: CropRect,
  handle: CropResizeHandle,
  deltaX: number,
  deltaY: number,
  canvasWidth: number,
  canvasHeight: number,
): CropRect {
  let left = -start.width * 0.5;
  let top = -start.height * 0.5;
  let right = start.width * 0.5;
  let bottom = start.height * 0.5;

  switch (handle) {
    case "top-left": {
      left = Math.min(left + deltaX, right - 1);
      top = Math.min(top + deltaY, bottom - 1);
      break;
    }
    case "top": {
      top = Math.min(top + deltaY, bottom - 1);
      break;
    }
    case "top-right": {
      right = Math.max(right + deltaX, left + 1);
      top = Math.min(top + deltaY, bottom - 1);
      break;
    }
    case "right": {
      right = Math.max(right + deltaX, left + 1);
      break;
    }
    case "bottom-right": {
      right = Math.max(right + deltaX, left + 1);
      bottom = Math.max(bottom + deltaY, top + 1);
      break;
    }
    case "bottom": {
      bottom = Math.max(bottom + deltaY, top + 1);
      break;
    }
    case "bottom-left": {
      left = Math.min(left + deltaX, right - 1);
      bottom = Math.max(bottom + deltaY, top + 1);
      break;
    }
    case "left": {
      left = Math.min(left + deltaX, right - 1);
      break;
    }
    default:
      throw new Error(`unsupported crop resize handle: ${handle satisfies never}`);
  }

  return buildCropRectFromLocalEdges(
    start,
    left,
    top,
    right,
    bottom,
    canvasWidth,
    canvasHeight,
  );
}

export function constrainCropDragToAspectRatio(
  start: CropRect,
  handle: CropResizeHandle,
  deltaX: number,
  deltaY: number,
  ratio: number,
  canvasWidth: number,
  canvasHeight: number,
): CropRect {
  const halfWidth = start.width * 0.5;
  const halfHeight = start.height * 0.5;

  switch (handle) {
    case "top":
    case "bottom": {
      const anchorY = handle === "top" ? halfHeight : -halfHeight;
      const preferredHeight =
        handle === "top" ? start.height - deltaY : start.height + deltaY;
      const { width, height } = clampAspectSize(
        preferredHeight * ratio,
        preferredHeight,
        ratio,
        canvasWidth,
        canvasHeight,
        "height",
      );
      return buildCropRectFromLocalEdges(
        start,
        -width * 0.5,
        handle === "top" ? anchorY - height : anchorY,
        width * 0.5,
        handle === "top" ? anchorY : anchorY + height,
        canvasWidth,
        canvasHeight,
      );
    }
    case "left":
    case "right": {
      const anchorX = handle === "left" ? halfWidth : -halfWidth;
      const preferredWidth =
        handle === "left" ? start.width - deltaX : start.width + deltaX;
      const { width, height } = clampAspectSize(
        preferredWidth,
        preferredWidth / ratio,
        ratio,
        canvasWidth,
        canvasHeight,
        "width",
      );
      return buildCropRectFromLocalEdges(
        start,
        handle === "left" ? anchorX - width : anchorX,
        -height * 0.5,
        handle === "left" ? anchorX : anchorX + width,
        height * 0.5,
        canvasWidth,
        canvasHeight,
      );
    }
    case "top-left":
    case "top-right":
    case "bottom-right":
    case "bottom-left": {
      const dragLeft = handle === "top-left" || handle === "bottom-left";
      const dragTop = handle === "top-left" || handle === "top-right";
      const anchorX = dragLeft ? halfWidth : -halfWidth;
      const anchorY = dragTop ? halfHeight : -halfHeight;
      const draggedX =
        (dragLeft ? -halfWidth : halfWidth) + deltaX;
      const draggedY =
        (dragTop ? -halfHeight : halfHeight) + deltaY;
      const numeratorX = dragLeft ? anchorX - draggedX : draggedX - anchorX;
      const numeratorY = dragTop ? anchorY - draggedY : draggedY - anchorY;
      const projectedHeight =
        (ratio * numeratorX + numeratorY) / (ratio * ratio + 1);
      const { width, height } = clampAspectSize(
        projectedHeight * ratio,
        projectedHeight,
        ratio,
        canvasWidth,
        canvasHeight,
        "height",
      );
      return buildCropRectFromLocalEdges(
        start,
        dragLeft ? anchorX - width : anchorX,
        dragTop ? anchorY - height : anchorY,
        dragLeft ? anchorX : anchorX + width,
        dragTop ? anchorY : anchorY + height,
        canvasWidth,
        canvasHeight,
      );
    }
    default:
      throw new Error(`unsupported crop resize handle: ${handle satisfies never}`);
  }
}
