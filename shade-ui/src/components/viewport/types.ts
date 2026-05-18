import type { MaskParamsInfo } from "../../bridge/types";

export type CropHandle =
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

export type MaskHandle = "start" | "end" | "center" | "edge";

export type PressedArtboardChrome =
  | { kind: "title"; artboardId: string }
  | { kind: "close"; artboardId: string }
  | null;

export type CropRectWithRotation = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type Gesture =
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
      crop: CropRectWithRotation;
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
  | {
      kind: "brush_paint";
      pointerId: number;
      lastImgX: number;
      lastImgY: number;
      erase: boolean;
    }
  | {
      kind: "text_move";
      pointerId: number;
      layerIdx: number;
      startImgX: number;
      startImgY: number;
      originTx: number;
      originTy: number;
    };
