import * as bridge from "../bridge/index";
import type { MaskThumbnail } from "../types";

export function getMaskThumbnail(
  layerIdx: number,
  maxW: number,
  maxH: number,
): Promise<MaskThumbnail> {
  return bridge.getMaskThumbnail(layerIdx, maxW, maxH);
}
