import sparkSvg from "../../icons/spark.svg?raw";
import circleSvg from "../../icons/circle.svg?raw";
import dropletSvg from "../../icons/droplet.svg?raw";
import grainSvg from "../../icons/grain.svg?raw";
import curveSvg from "../../icons/curve.svg?raw";
import toneSvg from "../../icons/tone.svg?raw";
import hslSvg from "../../icons/hsl.svg?raw";
import cropSvg from "../../icons/crop.svg?raw";
import trashSvg from "../../icons/trash.svg?raw";
import denoiseSvg from "../../icons/denoise.svg?raw";
import type { MobileLayerFocus } from "./inspector-constants";

export {
  circleSvg,
  cropSvg,
  curveSvg,
  denoiseSvg,
  dropletSvg,
  grainSvg,
  hslSvg,
  sparkSvg,
  toneSvg,
  trashSvg,
};

export const focusGlyphs: Record<MobileLayerFocus, string> = {
  light: sparkSvg,
  levels: toneSvg,
  color: dropletSvg,
  wb: toneSvg,
  curves: curveSvg,
  ls_curve: curveSvg,
  grain: grainSvg,
  glow: sparkSvg,
  vignette: circleSvg,
  sharpen: dropletSvg,
  hsl: hslSvg,
  denoise: denoiseSvg,
};
