import circleSvg from "../../assets/icons/circle.svg?raw";
import cropSvg from "../../assets/icons/crop.svg?raw";
import curveSvg from "../../assets/icons/curve.svg?raw";
import denoiseSvg from "../../assets/icons/denoise.svg?raw";
import dropletSvg from "../../assets/icons/droplet.svg?raw";
import grainSvg from "../../assets/icons/grain.svg?raw";
import hslSvg from "../../assets/icons/hsl.svg?raw";
import sparkSvg from "../../assets/icons/spark.svg?raw";
import toneSvg from "../../assets/icons/tone.svg?raw";
import trashSvg from "../../assets/icons/trash.svg?raw";
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
