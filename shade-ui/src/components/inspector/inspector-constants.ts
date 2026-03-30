import type { LayerInfo } from "../../store/editor";
import { IDENTITY_LUT } from "./curve-utils";

export type MobileLayerFocus =
  | "light"
  | "levels"
  | "color"
  | "wb"
  | "curves"
  | "ls_curve"
  | "grain"
  | "glow"
  | "vignette"
  | "sharpen"
  | "hsl"
  | "denoise";

export const ADD_LAYER_FOCI = [
  "light",
  "levels",
  "color",
  "wb",
  "curves",
  "ls_curve",
  "grain",
  "glow",
  "vignette",
  "sharpen",
  "hsl",
  "denoise",
] as const satisfies readonly MobileLayerFocus[];

export const DEFAULT_TONE = {
  exposure: 0,
  contrast: 0,
  blacks: 0,
  whites: 0,
  highlights: 0,
  shadows: 0,
  gamma: 1,
} as const;

export const DEFAULT_COLOR = {
  saturation: 1,
  vibrancy: 0,
  temperature: 0,
  tint: 0,
} as const;

export const DEFAULT_VIGNETTE = { amount: 0 } as const;
export const DEFAULT_SHARPEN = { amount: 0 } as const;
export const DEFAULT_GRAIN = { amount: 0, size: 1 } as const;
export const DEFAULT_GLOW = { amount: 0 } as const;
export const DEFAULT_DENOISE = {
  luma_strength: 0,
  chroma_strength: 0,
  mode: 0,
} as const;

export const DEFAULT_CURVES = {
  lut_r: IDENTITY_LUT,
  lut_g: IDENTITY_LUT,
  lut_b: IDENTITY_LUT,
  lut_master: IDENTITY_LUT,
  per_channel: false,
} as const;

export const DEFAULT_HSL = {
  red_hue: 0,
  red_sat: 0,
  red_lum: 0,
  green_hue: 0,
  green_sat: 0,
  green_lum: 0,
  blue_hue: 0,
  blue_sat: 0,
  blue_lum: 0,
} as const;

export const HSL_TAB_STYLES = {
  red: { tabClass: "text-red-400 bg-red-500/15", accentColor: "#f87171" },
  green: { tabClass: "text-green-400 bg-green-500/15", accentColor: "#4ade80" },
  blue: { tabClass: "text-blue-400 bg-blue-500/15", accentColor: "#60a5fa" },
} as const;

export const focusLabels: Record<MobileLayerFocus, string> = {
  light: "Light",
  levels: "Levels",
  color: "Color",
  wb: "WB",
  curves: "Curves",
  ls_curve: "LS Curve",
  grain: "Grain",
  glow: "Glow",
  vignette: "Vignette",
  sharpen: "Sharpen",
  hsl: "HSL",
  denoise: "Denoise",
};

const ADJUSTMENT_FOCUS_MAP: readonly {
  key: keyof NonNullable<LayerInfo["adjustments"]>;
  focus: MobileLayerFocus;
}[] = [
  { key: "tone", focus: "light" },
  { key: "color", focus: "color" },
  { key: "curves", focus: "curves" },
  { key: "ls_curve", focus: "ls_curve" },
  { key: "grain", focus: "grain" },
  { key: "glow", focus: "glow" },
  { key: "vignette", focus: "vignette" },
  { key: "sharpen", focus: "sharpen" },
  { key: "hsl", focus: "hsl" },
  { key: "denoise", focus: "denoise" },
] as const;

export function inferFocus(layer: LayerInfo | undefined): MobileLayerFocus {
  const adjustments = layer?.adjustments;
  if (!adjustments) {
    return "light";
  }
  for (const { key, focus } of ADJUSTMENT_FOCUS_MAP) {
    if (adjustments[key] != null) {
      return focus;
    }
  }
  return "light";
}
