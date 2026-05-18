import { getSelectedArtboard, state } from "../../store/editor-store";
import { useOpenImage } from "../../store/use-open-image";
import { buildTransform, type WorldTransform } from "../../viewport/transform";

export function getViewWorldOffset(): { x: number; y: number } {
  const artboard = getSelectedArtboard();
  return artboard ? { x: artboard.worldX, y: artboard.worldY } : { x: 0, y: 0 };
}

export function toWorldX(localX: number): number {
  return localX + getViewWorldOffset().x;
}

export function toWorldY(localY: number): number {
  return localY + getViewWorldOffset().y;
}

export function getViewTransform(cssWidth: number, cssHeight: number): WorldTransform {
  const offset = getViewWorldOffset();
  const fit = useOpenImage().getViewportFitRef();
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

export function getCropEditTransform(
  cssWidth: number,
  cssHeight: number,
): WorldTransform {
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
