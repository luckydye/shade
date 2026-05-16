/**
 * Browser-side preset-layer application. Walks a `BrowserPresetLayer` and
 * issues the equivalent unified-protocol mutations through the bridge.
 * Used by `webHostHooks.restoreCurrentBrowserSnapshot`.
 */

import type { AdjustmentValues, BrowserPresetLayer } from "shade-ui/src/bridge/index";
import {
  addLayer,
  applyEdit,
  applyGradientMask,
  renameLayer,
  setLayerOpacity,
  setLayerVisible,
} from "shade-ui/src/bridge/index";

function requiredNumber(value: number | null | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`preset mask is missing ${label}`);
  }
  return value;
}

async function applyAdjustment(layerIdx: number, adjustments: AdjustmentValues) {
  if (adjustments.tone) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "tone",
      exposure: adjustments.tone.exposure,
      contrast: adjustments.tone.contrast,
      blacks: adjustments.tone.blacks,
      whites: adjustments.tone.whites,
      highlights: adjustments.tone.highlights,
      shadows: adjustments.tone.shadows,
      gamma: adjustments.tone.gamma,
    });
  }
  if (adjustments.color) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "color",
      saturation: adjustments.color.saturation,
      vibrancy: adjustments.color.vibrancy,
      temperature: adjustments.color.temperature,
      tint: adjustments.color.tint,
    });
  }
  if (adjustments.curves) {
    if (!adjustments.curves.control_points) {
      throw new Error("preset curves are missing control points");
    }
    await applyEdit({
      layer_idx: layerIdx,
      op: "curves",
      curve_points: adjustments.curves.control_points,
    });
  }
  if (adjustments.ls_curve) {
    if (!adjustments.ls_curve.control_points) {
      throw new Error("preset ls_curve are missing control points");
    }
    await applyEdit({
      layer_idx: layerIdx,
      op: "ls_curve",
      curve_points: adjustments.ls_curve.control_points,
    });
  }
  if (adjustments.vignette) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "vignette",
      vignette_amount: adjustments.vignette.amount,
    });
  }
  if (adjustments.sharpen) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "sharpen",
      sharpen_amount: adjustments.sharpen.amount,
    });
  }
  if (adjustments.grain) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "grain",
      grain_amount: adjustments.grain.amount,
      grain_size: adjustments.grain.size,
    });
  }
  if (adjustments.glow) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "glow",
      glow_amount: adjustments.glow.amount,
    });
  }
  if (adjustments.hsl) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "hsl",
      red_hue: adjustments.hsl.red_hue,
      red_sat: adjustments.hsl.red_sat,
      red_lum: adjustments.hsl.red_lum,
      green_hue: adjustments.hsl.green_hue,
      green_sat: adjustments.hsl.green_sat,
      green_lum: adjustments.hsl.green_lum,
      blue_hue: adjustments.hsl.blue_hue,
      blue_sat: adjustments.hsl.blue_sat,
      blue_lum: adjustments.hsl.blue_lum,
    });
  }
  if (adjustments.denoise) {
    await applyEdit({
      layer_idx: layerIdx,
      op: "denoise",
      denoise_luma_strength: adjustments.denoise.luma_strength,
      denoise_chroma_strength: adjustments.denoise.chroma_strength,
      denoise_mode: adjustments.denoise.mode,
    });
  }
}

export async function applyBrowserPresetLayer(layer: BrowserPresetLayer) {
  const layerIdx = await addLayer(layer.kind);
  if (layer.kind === "crop") {
    if (!layer.crop) throw new Error("crop layer is missing crop values");
    await applyEdit({
      layer_idx: layerIdx,
      op: "crop",
      crop_x: layer.crop.x,
      crop_y: layer.crop.y,
      crop_width: layer.crop.width,
      crop_height: layer.crop.height,
      crop_rotation: layer.crop.rotation,
    });
  } else if (layer.adjustments) {
    await applyAdjustment(layerIdx, layer.adjustments);
  }
  if (layer.mask_params) {
    if (layer.mask_params.kind === "linear") {
      await applyGradientMask({
        kind: "linear",
        layer_idx: layerIdx,
        x1: requiredNumber(layer.mask_params.x1, "x1"),
        y1: requiredNumber(layer.mask_params.y1, "y1"),
        x2: requiredNumber(layer.mask_params.x2, "x2"),
        y2: requiredNumber(layer.mask_params.y2, "y2"),
      });
    } else if (layer.mask_params.kind === "radial") {
      await applyGradientMask({
        kind: "radial",
        layer_idx: layerIdx,
        cx: requiredNumber(layer.mask_params.cx, "cx"),
        cy: requiredNumber(layer.mask_params.cy, "cy"),
        radius: requiredNumber(layer.mask_params.radius, "radius"),
      });
    } else {
      throw new Error("browser presets do not support brush masks");
    }
  }
  if (layer.name !== null) await renameLayer(layerIdx, layer.name);
  if (layer.opacity !== 1) await setLayerOpacity(layerIdx, layer.opacity);
  if (!layer.visible) await setLayerVisible(layerIdx, false);
}
