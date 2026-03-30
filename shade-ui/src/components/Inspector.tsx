import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Slider } from "./Slider";
import sparkSvg from "../icons/spark.svg?raw";
import circleSvg from "../icons/circle.svg?raw";
import dropletSvg from "../icons/droplet.svg?raw";
import grainSvg from "../icons/grain.svg?raw";
import curveSvg from "../icons/curve.svg?raw";
import toneSvg from "../icons/tone.svg?raw";
import hslSvg from "../icons/hsl.svg?raw";
import cropSvg from "../icons/crop.svg?raw";
import trashSvg from "../icons/trash.svg?raw";
import denoiseSvg from "../icons/denoise.svg?raw";
import type { LayerInfo } from "../store/editor";
import {
  activeAdjustmentSliderId,
  addLayer,
  applyEdit,
  applyGradientMask,
  createBrushMask,
  backdropTile,
  deleteLayer,
  findCropLayerIdx,
  isAdjustmentSliderActive,
  isDrawerOpen,
  listPresets,
  listSnapshots,
  loadPreset,
  loadSnapshot,
  moveLayer,
  removeMask,
  renameLayer,
  renamePreset,
  savePreset,
  saveSnapshot,
  selectLayer,
  setActiveAdjustmentSliderId,
  setIsAdjustmentSliderActive,
  setIsDrawerOpen,
  setLayerVisible,
  state,
  viewportToneSample,
} from "../store/editor";
import {
  type ArtboardSource,
  getLayerDefaultName,
  getLayerDisplayName,
  getSelectedArtboard,
} from "../store/editor-store";
import { Button } from "./Button";

type MobileLayerFocus =
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
type InspectorTab = "edit" | "presets";
type LayerDropTarget = { layerIdx: number; position: "before" | "after" };

const PANEL_SHELL_CLASS =
  "gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel-bg)] p-3 pr-0";
const SECTION_TITLE_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-faint)]";
const PARAMETER_ROW_CLASS =
  "grid grid-cols-[16px_minmax(0,1fr)_56px] gap-x-2 gap-y-0.5 py-0.5";
const SEGMENTED_CONTROL_CLASS = "grid h-8 rounded-lg bg-[var(--surface)] p-0.5";
const SEGMENT_BUTTON_CLASS =
  "rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.03em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const SECONDARY_BUTTON_CLASS =
  "h-8 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-40";
const INPUT_CLASS =
  "h-8 w-full border border-[var(--border)] bg-[var(--input-bg)] px-2 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)] focus-visible:ring-1 focus-visible:ring-[var(--border-active)] disabled:opacity-45";
const EMPTY_STATE_CLASS =
  "rounded-lg border border-dashed border-[var(--border-medium)] bg-[var(--surface-subtle)] px-3 py-4 text-sm text-[var(--text-faint)]";
const LAYER_ROW_CLASS =
  "grid h-8 grid-cols-[16px_16px_16px_minmax(0,1fr)_24px_20px] items-center gap-2.5 rounded-md px-2";
const ADD_LAYER_ROW_CLASS =
  "grid h-7 grid-cols-[0px_16px_16px_minmax(0,1fr)_24px_20px] items-center gap-2.5 rounded-md px-2 text-left text-[12px] font-medium text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const MOBILE_LAYER_TAB_CLASS =
  "flex min-w-[3.5rem] flex-col items-center gap-1 px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.03em] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]";
const ADD_LAYER_FOCI = [
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

const CURVE_SAMPLE_INDICES = [64, 128, 192] as const;
const CURVE_MIN_X = 0;
const CURVE_MAX_X = 255;
const IDENTITY_LUT = Array.from({ length: 256 }, (_, idx) => idx / 255);
const LS_CURVE_IDENTITY = Array.from({ length: 256 }, () => 1.0);
const DEFAULT_TONE = {
  exposure: 0,
  contrast: 0,
  blacks: 0,
  whites: 0,
  highlights: 0,
  shadows: 0,
  gamma: 1,
} as const;
const DEFAULT_COLOR = {
  saturation: 1,
  vibrancy: 0,
  temperature: 0,
  tint: 0,
} as const;
const DEFAULT_VIGNETTE = { amount: 0 } as const;
const DEFAULT_SHARPEN = { amount: 0 } as const;
const DEFAULT_GRAIN = { amount: 0, size: 1 } as const;
const DEFAULT_GLOW = { amount: 0 } as const;
const DEFAULT_DENOISE = { luma_strength: 0, chroma_strength: 0, mode: 0 } as const;
const DEFAULT_CURVES = {
  lut_r: IDENTITY_LUT,
  lut_g: IDENTITY_LUT,
  lut_b: IDENTITY_LUT,
  lut_master: IDENTITY_LUT,
  per_channel: false,
} as const;
const DEFAULT_HSL = {
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
const HSL_TAB_STYLES = {
  red: { tabClass: "text-red-400 bg-red-500/15", accentColor: "#f87171" },
  green: { tabClass: "text-green-400 bg-green-500/15", accentColor: "#4ade80" },
  blue: { tabClass: "text-blue-400 bg-blue-500/15", accentColor: "#60a5fa" },
} as const;

interface ControlPoint {
  x: number;
  y: number;
}

interface EditableControlPoint extends ControlPoint {
  id: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizePoints(points: readonly ControlPoint[]): ControlPoint[] {
  const normalized = [...points]
    .map(normalizePoint)
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
  if (normalized[0]?.x !== CURVE_MIN_X) {
    normalized.unshift({ x: CURVE_MIN_X, y: 0 });
  }
  if (normalized[normalized.length - 1]?.x !== CURVE_MAX_X) {
    normalized.push({ x: CURVE_MAX_X, y: 1 });
  }
  return normalized;
}

function normalizeLsPoints(points: readonly ControlPoint[]): ControlPoint[] {
  const normalized = [...points]
    .map(normalizeLsPoint)
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
  if (normalized[0]?.x !== CURVE_MIN_X) {
    normalized.unshift({ x: CURVE_MIN_X, y: 1 });
  }
  if (normalized[normalized.length - 1]?.x !== CURVE_MAX_X) {
    normalized.push({ x: CURVE_MAX_X, y: 1 });
  }
  return normalized;
}

function buildLutFromPoints(points: readonly ControlPoint[]): number[] {
  const anchors = normalizePoints(points);
  if (anchors.length < 2) {
    throw new Error("curve requires explicit left and right endpoint clamps");
  }
  if (anchors[0]?.x !== CURVE_MIN_X) {
    throw new Error("curve must include a left endpoint clamp at x=0");
  }
  if (anchors[anchors.length - 1]?.x !== CURVE_MAX_X) {
    throw new Error("curve must include a right endpoint clamp at x=255");
  }
  const lut = new Array<number>(256);
  const delta = new Array<number>(anchors.length - 1);
  const tangent = new Array<number>(anchors.length);
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const span = anchors[i + 1].x - anchors[i].x;
    if (span <= 0) throw new Error("curve anchors must be strictly increasing");
    delta[i] = (anchors[i + 1].y - anchors[i].y) / span;
  }
  tangent[0] = delta[0];
  tangent[anchors.length - 1] = delta[delta.length - 1];
  for (let i = 1; i < anchors.length - 1; i += 1) {
    tangent[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < delta.length; i += 1) {
    if (delta[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / delta[i];
    const b = tangent[i + 1] / delta[i];
    const norm = Math.hypot(a, b);
    if (norm > 3) {
      const scale = 3 / norm;
      tangent[i] = scale * a * delta[i];
      tangent[i + 1] = scale * b * delta[i];
    }
  }
  for (let seg = 0; seg < anchors.length - 1; seg += 1) {
    const start = anchors[seg];
    const end = anchors[seg + 1];
    const span = end.x - start.x;
    for (let x = start.x; x <= end.x; x += 1) {
      const t = (x - start.x) / span;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      lut[x] = clamp(
        h00 * start.y +
          h10 * span * tangent[seg] +
          h01 * end.y +
          h11 * span * tangent[seg + 1],
        0,
        1,
      );
    }
  }
  return lut;
}

function buildLsCurveLutFromPoints(points: readonly ControlPoint[]): number[] {
  const anchors = normalizeLsPoints(points);
  if (anchors.length < 2) {
    throw new Error("curve requires explicit left and right endpoint clamps");
  }
  if (anchors[0]?.x !== CURVE_MIN_X) {
    throw new Error("curve must include a left endpoint clamp at x=0");
  }
  if (anchors[anchors.length - 1]?.x !== CURVE_MAX_X) {
    throw new Error("curve must include a right endpoint clamp at x=255");
  }
  const lut = new Array<number>(256);
  const delta = new Array<number>(anchors.length - 1);
  const tangent = new Array<number>(anchors.length);
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const span = anchors[i + 1].x - anchors[i].x;
    if (span <= 0) throw new Error("curve anchors must be strictly increasing");
    delta[i] = (anchors[i + 1].y - anchors[i].y) / span;
  }
  tangent[0] = delta[0];
  tangent[anchors.length - 1] = delta[delta.length - 1];
  for (let i = 1; i < anchors.length - 1; i += 1) {
    tangent[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < delta.length; i += 1) {
    if (delta[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / delta[i];
    const b = tangent[i + 1] / delta[i];
    const norm = Math.hypot(a, b);
    if (norm > 3) {
      const scale = 3 / norm;
      tangent[i] = scale * a * delta[i];
      tangent[i + 1] = scale * b * delta[i];
    }
  }
  for (let seg = 0; seg < anchors.length - 1; seg += 1) {
    const start = anchors[seg];
    const end = anchors[seg + 1];
    const span = end.x - start.x;
    for (let x = start.x; x <= end.x; x += 1) {
      const t = (x - start.x) / span;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      lut[x] = clamp(
        h00 * start.y +
          h10 * span * tangent[seg] +
          h01 * end.y +
          h11 * span * tangent[seg + 1],
        0,
        2,
      );
    }
  }
  return lut;
}

function normalizePoint(point: ControlPoint): ControlPoint {
  const roundedX = Math.round(point.x);
  return {
    x:
      roundedX <= CURVE_MIN_X
        ? CURVE_MIN_X
        : roundedX >= CURVE_MAX_X
          ? CURVE_MAX_X
          : clamp(roundedX, 1, 254),
    y: clamp(point.y, 0, 1),
  };
}

function normalizeLsPoint(point: ControlPoint): ControlPoint {
  const roundedX = Math.round(point.x);
  return {
    x:
      roundedX <= CURVE_MIN_X
        ? CURVE_MIN_X
        : roundedX >= CURVE_MAX_X
          ? CURVE_MAX_X
          : clamp(roundedX, 1, 254),
    y: clamp(point.y, 0, 2),
  };
}

function normalizeInteriorPoint(point: ControlPoint): ControlPoint {
  return {
    x: clamp(Math.round(point.x), 1, 254),
    y: clamp(point.y, 0, 1),
  };
}

function normalizeLsInteriorPoint(point: ControlPoint): ControlPoint {
  return {
    x: clamp(Math.round(point.x), 1, 254),
    y: clamp(point.y, 0, 2),
  };
}

function isEndpointPoint(point: ControlPoint) {
  return point.x === CURVE_MIN_X || point.x === CURVE_MAX_X;
}

function curvePath(lut: readonly number[]) {
  return lut
    .map((value, idx) => {
      const x = (idx / 255) * 100;
      const y = (1 - clamp(value, 0, 1)) * 100;
      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function lsCurvePath(lut: readonly number[]) {
  return lut
    .map((value, idx) => {
      const x = (idx / 255) * 100;
      const y = ((2 - clamp(value, 0, 2)) / 2) * 100;
      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function buildLuminanceHistogram(frame: ImageData, binCount = 64) {
  const bins = new Array<number>(binCount).fill(0);
  const { data } = frame;
  for (let idx = 0; idx < data.length; idx += 4) {
    const alpha = data[idx + 3] / 255;
    if (alpha <= 0) continue;
    const luminance =
      ((data[idx] / 255) * 0.2126 +
        (data[idx + 1] / 255) * 0.7152 +
        (data[idx + 2] / 255) * 0.0722) *
      alpha;
    const binIdx = Math.min(binCount - 1, Math.floor(luminance * (binCount - 1)));
    bins[binIdx] += 1;
  }
  return bins;
}

function histogramPath(bins: readonly number[]) {
  const peak = Math.max(...bins, 0);
  if (peak <= 0) return "";
  const step = 100 / Math.max(1, bins.length - 1);
  const points = bins.map((value, idx) => {
    const x = idx * step;
    const y = 100 - (value / peak) * 100;
    return `${x} ${y}`;
  });
  return `M 0 100 L ${points.join(" L ")} L 100 100 Z`;
}

function remapPath(path: string, width: number, height: number, padding: number) {
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  return path.replace(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g, (_, x, y) => {
    const nextX = padding + (parseFloat(x) / 100) * innerWidth;
    const nextY = padding + (parseFloat(y) / 100) * innerHeight;
    return `${nextX} ${nextY}`;
  });
}

function sampleCurveValue(lut: readonly number[], x: number) {
  const clampedX = clamp(x, 0, 255);
  const lower = Math.floor(clampedX);
  const upper = Math.ceil(clampedX);
  const start = clamp(lut[lower] ?? 0, 0, 1);
  const end = clamp(lut[upper] ?? start, 0, 1);
  return start + (end - start) * (clampedX - lower);
}

function valueLabel(value: number, scale = 100) {
  return `${Math.round(value * scale)}`;
}

const TONE_THRESHOLD_BOUNDARIES = [
  { key: "shadows", label: "Shadows", value: 0.25 },
  { key: "midtones", label: "Midtones", value: 0.5 },
  { key: "highlights", label: "Highlights", value: 0.75 },
] as const;

const focusGlyphs: Record<MobileLayerFocus, string> = {
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

const focusLabels: Record<MobileLayerFocus, string> = {
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

function inferFocus(layer: LayerInfo | undefined): MobileLayerFocus {
  const adj = layer?.adjustments;
  if (!adj) return "light";
  for (const { key, focus } of ADJUSTMENT_FOCUS_MAP) {
    if (adj[key] != null) return focus;
  }
  return "light";
}

const LayerTypeIcon: Component<{ layer: LayerInfo }> = (props) => {
  if (props.layer.kind === "crop") {
    return <span innerHTML={cropSvg} />;
  }
  if (props.layer.kind === "adjustment") {
    return <span innerHTML={sparkSvg} />;
  }
  return (
    <span class="inline-block h-4 w-4 rounded-sm border border-[var(--border-medium)]" />
  );
};

const SectionHeader: Component<{ title: string; detail?: string | (() => string) }> = (props) => (
  <div
    data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
    class="mobile-slider-fade mt-2 flex items-center justify-between gap-3 transition-opacity duration-150"
  >
    <div class={SECTION_TITLE_CLASS}>{props.title}</div>
    <Show when={props.detail}>
      {(detail) => {
        const value = () => {
          const d = detail();
          return typeof d === "function" ? d() : d;
        };
        return (
          <div class="text-xs font-medium tabular-nums text-[var(--text-value)]">
            {value()}
          </div>
        );
      }}
    </Show>
  </div>
);

const EmptyState: Component<{ children: JSX.Element }> = (props) => (
  <div class={EMPTY_STATE_CLASS}>{props.children}</div>
);

const ControlSection: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="flex flex-col gap-2">
    <SectionHeader title={props.title} />
    <div class="flex flex-col">{props.children}</div>
  </section>
);

function imageSourceDetail(source: ArtboardSource) {
  switch (source.kind) {
    case "path":
      return {
        filename: source.path.split(/[\\/]/).pop() ?? source.path,
        location: source.path,
        source: "Disk",
      };
    case "file":
      return {
        filename: source.file.name,
        location: "Imported file",
        source: "File",
      };
    case "peer":
      return {
        filename: source.picture.name,
        location: source.peerEndpointId,
        source: "Peer",
      };
    default:
      throw new Error("unsupported artboard source");
  }
}

export const Inspector: Component = () => {
  const [layerFocusOverrides, setLayerFocusOverrides] = createSignal(
    new Map<number, MobileLayerFocus>(),
  );
  const [curvePointCache, setCurvePointCache] = createSignal(
    new Map<number, ControlPoint[]>(),
  );
  const [lsCurvePointCache, setLsCurvePointCache] = createSignal(
    new Map<number, ControlPoint[]>(),
  );
  const [lastCanvasKey, setLastCanvasKey] = createSignal<string>("");
  createEffect(() => {
    const key = `${state.canvasWidth}x${state.canvasHeight}`;
    const prev = lastCanvasKey();
    if (prev && prev !== key) {
      setCurvePointCache(new Map());
      setLsCurvePointCache(new Map());
    }
    setLastCanvasKey(key);
  });
  const [pendingAddedLayerFocus, setPendingAddedLayerFocus] =
    createSignal<MobileLayerFocus | null>(null);
  const [isPickerOpen, setIsPickerOpen] = createSignal(false);
  const [maskPickerLayer, setMaskPickerLayer] = createSignal<number | null>(null);
  const [hslTab, setHslTab] = createSignal<"red" | "green" | "blue">("red");
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>("edit");
  const [presets, setPresets] = createSignal<{ name: string }[]>([]);
  const [snapshots, setSnapshots] = createSignal<
    { id: string; display_index: number; created_at: number; is_current: boolean }[]
  >([]);
  const [presetStatus, setPresetStatus] = createSignal<string | null>(null);
  const [isPresetBusy, setIsPresetBusy] = createSignal(false);
  const [editingPresetName, setEditingPresetName] = createSignal<string | null>(null);
  const [editingPresetValue, setEditingPresetValue] = createSignal("");
  const [editingLayerIdx, setEditingLayerIdx] = createSignal<number | null>(null);
  const [editingLayerName, setEditingLayerName] = createSignal("");
  const [draggedLayerIdx, setDraggedLayerIdx] = createSignal<number | null>(null);
  const [dropTarget, setDropTarget] = createSignal<LayerDropTarget | null>(null);
  let desktopLayerListRef: HTMLDivElement | undefined;

  const selectedLayer = () => state.layers[state.selectedLayerIdx];
  const selectedArtboard = () => getSelectedArtboard();
  const selectedCropLayer = () => {
    const layer = selectedLayer();
    return layer?.kind === "crop" ? layer : null;
  };
  const selectedAdjustmentLayer = () => {
    const layer = selectedLayer();
    return layer?.kind === "adjustment" ? layer : null;
  };
  const selectedAdjustmentLayerOrThrow = () => {
    const layer = selectedAdjustmentLayer();
    if (!layer) throw new Error("selected layer is not an adjustment layer");
    return layer;
  };
  const defaultCurvePoints = () =>
    normalizePoints(CURVE_SAMPLE_INDICES.map((x) => ({ x, y: IDENTITY_LUT[x] })));
  const defaultLsCurvePoints = () =>
    normalizeLsPoints(CURVE_SAMPLE_INDICES.map((x) => ({ x, y: LS_CURVE_IDENTITY[x] })));

  const tone = () =>
    selectedAdjustmentLayer()?.adjustments?.tone ?? {
      ...DEFAULT_TONE,
    };
  const curves = () => selectedAdjustmentLayer()?.adjustments?.curves ?? DEFAULT_CURVES;
  const color = () => selectedAdjustmentLayer()?.adjustments?.color ?? DEFAULT_COLOR;
  const vignette = () =>
    selectedAdjustmentLayer()?.adjustments?.vignette ?? DEFAULT_VIGNETTE;
  const sharpen = () =>
    selectedAdjustmentLayer()?.adjustments?.sharpen ?? DEFAULT_SHARPEN;
  const grain = () => selectedAdjustmentLayer()?.adjustments?.grain ?? DEFAULT_GRAIN;
  const glow = () => selectedAdjustmentLayer()?.adjustments?.glow ?? DEFAULT_GLOW;
  const hsl = () => selectedAdjustmentLayer()?.adjustments?.hsl ?? DEFAULT_HSL;
  const denoise = () =>
    selectedAdjustmentLayer()?.adjustments?.denoise ?? DEFAULT_DENOISE;

  const clearLayerDragState = () => {
    setDraggedLayerIdx(null);
    setDropTarget(null);
  };

  const updateLayerDropTarget = (target: LayerDropTarget) => {
    setDropTarget(target);
  };

  const commitLayerDrop = async () => {
    const fromIdx = draggedLayerIdx();
    const target = dropTarget();
    clearLayerDragState();
    if (fromIdx === null || target === null) {
      return;
    }
    await moveLayer(
      fromIdx,
      target.position === "before" ? target.layerIdx + 1 : target.layerIdx,
    );
  };

  const resolveDesktopDropTarget = (container: HTMLDivElement, clientY: number) => {
    const rows = Array.from(
      container.querySelectorAll<HTMLDivElement>("[data-layer-idx]"),
    );
    if (rows.length === 0) {
      return null;
    }
    for (const row of rows) {
      const layerIdx = Number(row.dataset.layerIdx);
      if (!Number.isInteger(layerIdx)) {
        throw new Error("desktop layer row is missing a valid layer index");
      }
      const bounds = row.getBoundingClientRect();
      const midY = bounds.top + bounds.height * 0.5;
      if (clientY < midY) {
        return { layerIdx, position: "before" } as LayerDropTarget;
      }
      if (clientY <= bounds.bottom) {
        return { layerIdx, position: "after" } as LayerDropTarget;
      }
    }
    const lastLayerIdx = Number(rows[rows.length - 1]?.dataset.layerIdx);
    if (!Number.isInteger(lastLayerIdx)) {
      throw new Error("desktop layer row is missing a valid layer index");
    }
    return { layerIdx: lastLayerIdx, position: "after" } as LayerDropTarget;
  };

  const getDesktopDropCursorStyle = () => {
    const container = desktopLayerListRef;
    const target = dropTarget();
    if (!container || !target) {
      return { opacity: 0 };
    }
    const row = container.querySelector<HTMLDivElement>(
      `[data-layer-idx="${target.layerIdx}"]`,
    );
    if (!row) {
      return { opacity: 0 };
    }
    const containerBounds = container.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const rows = Array.from(
      container.querySelectorAll<HTMLDivElement>("[data-layer-idx]"),
    );
    const rowIndex = rows.findIndex(
      (candidate) => Number(candidate.dataset.layerIdx) === target.layerIdx,
    );
    if (rowIndex < 0) {
      return { opacity: 0 };
    }
    const previousRow = rows[rowIndex - 1];
    const nextRow = rows[rowIndex + 1];
    const top =
      target.position === "before"
        ? previousRow
          ? (previousRow.getBoundingClientRect().bottom + rowBounds.top) * 0.5 -
            containerBounds.top
          : rowBounds.top - containerBounds.top
        : nextRow
          ? (rowBounds.bottom + nextRow.getBoundingClientRect().top) * 0.5 -
            containerBounds.top
          : rowBounds.bottom - containerBounds.top;
    return {
      opacity: 1,
      transform: `translateY(${top}px)`,
    };
  };

  const startDesktopLayerDrag = (event: PointerEvent, layerIdx: number) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    setDraggedLayerIdx(layerIdx);
    const onPointerMove = (moveEvent: PointerEvent) => {
      const container = desktopLayerListRef;
      if (!container) {
        throw new Error("desktop layer list is required for drag reordering");
      }
      const target = resolveDesktopDropTarget(container, moveEvent.clientY);
      if (target) {
        updateLayerDropTarget(target);
      }
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      void commitLayerDrop();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    onPointerMove(event);
  };

  const applyCurves = (points: readonly ControlPoint[]) => {
    const normalizedPoints = normalizePoints(points);
    setCurvePointCache((prev) =>
      new Map(prev).set(state.selectedLayerIdx, normalizedPoints),
    );
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "curves",
      curve_points: normalizedPoints,
    });
  };

  const applyLsCurve = (points: readonly ControlPoint[]) => {
    const normalizedPoints = normalizePoints(points);
    setLsCurvePointCache((prev) =>
      new Map(prev).set(state.selectedLayerIdx, normalizedPoints),
    );
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "ls_curve",
      curve_points: normalizedPoints,
    });
  };

  const applyHsl = (next: Partial<ReturnType<typeof hsl>>) => {
    const current = hsl();
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "hsl",
      red_hue: next.red_hue ?? current.red_hue,
      red_sat: next.red_sat ?? current.red_sat,
      red_lum: next.red_lum ?? current.red_lum,
      green_hue: next.green_hue ?? current.green_hue,
      green_sat: next.green_sat ?? current.green_sat,
      green_lum: next.green_lum ?? current.green_lum,
      blue_hue: next.blue_hue ?? current.blue_hue,
      blue_sat: next.blue_sat ?? current.blue_sat,
      blue_lum: next.blue_lum ?? current.blue_lum,
    });
  };

  const applyTone = (overrides: Partial<ReturnType<typeof tone>>) => {
    selectedAdjustmentLayerOrThrow();
    const t = tone();
    void applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "tone",
      exposure: overrides.exposure ?? t.exposure,
      contrast: overrides.contrast ?? t.contrast,
      blacks: overrides.blacks ?? t.blacks,
      whites: overrides.whites ?? t.whites,
      highlights: overrides.highlights ?? t.highlights,
      shadows: overrides.shadows ?? t.shadows,
      gamma: overrides.gamma ?? t.gamma,
    });
  };

  const applyColor = (overrides: Partial<ReturnType<typeof color>>) => {
    selectedAdjustmentLayerOrThrow();
    const c = color();
    void applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "color",
      saturation: overrides.saturation ?? c.saturation,
      vibrancy: overrides.vibrancy ?? c.vibrancy,
      temperature: overrides.temperature ?? c.temperature,
      tint: overrides.tint ?? c.tint,
    });
  };

  // Defined as a component (not a plain function) so SolidJS gives it a stable reactive
  // boundary. Plain function calls like {renderFn()} are wrapped in a single reactive
  // computation and replace their entire DOM subtree on any signal change — which kills
  // an active drag. A component (<HslSection />) gets fine-grained in-place updates.
  const CurvesEditor: Component = () => {
    const [draggingId, setDraggingId] = createSignal<number | null>(null);
    const [hoveredId, setHoveredId] = createSignal<number | null>(null);
    const [pts, setPts] = createSignal<EditableControlPoint[]>([]);
    const [svgSize, setSvgSize] = createSignal({ width: 100, height: 160 });
    const luminanceHistogram = createMemo(() => {
      const frame = backdropTile();
      return frame ? buildLuminanceHistogram(frame.image) : [];
    });
    let svgRef!: SVGSVGElement;
    let nextId = 0;
    let lastTapTime = 0;
    let lastTapId = -1;
    let activeTouchId: number | null = null;
    let clearCurveDragListeners: (() => void) | null = null;

    createEffect(
      on(
        () => state.selectedLayerIdx,
        (layerIdx) => {
          const layer = state.layers[layerIdx];
          if (layer?.kind !== "adjustment") {
            setPts([]);
            setDraggingId(null);
            setHoveredId(null);
            return;
          }
          const points =
            curvePointCache().get(layerIdx) ??
            layer.adjustments?.curves?.control_points ??
            defaultCurvePoints();
          nextId = 0;
          setPts(
            normalizePoints(points.length === 0 ? defaultCurvePoints() : points).map(
              (point) => ({
                ...point,
                id: nextId++,
              }),
            ),
          );
          setDraggingId(null);
          setHoveredId(null);
        },
      ),
    );

    const lut = () => buildLutFromPoints(pts());
    const graphPadding = 0;
    const innerWidth = () => Math.max(1, svgSize().width - graphPadding * 2);
    const innerHeight = () => Math.max(1, svgSize().height - graphPadding * 2);
    const chartX = (value: number) => graphPadding + (value / 255) * innerWidth();
    const chartY = (value: number) => graphPadding + (1 - value) * innerHeight();
    const chartThresholdX = (value: number) => graphPadding + value * innerWidth();
    const curveSvgPath = () =>
      remapPath(curvePath(lut()), svgSize().width, svgSize().height, graphPadding);
    const histogramSvgPath = () =>
      remapPath(
        histogramPath(luminanceHistogram()),
        svgSize().width,
        svgSize().height,
        graphPadding,
      );
    const hoveredToneGuide = createMemo(() => {
      const x = viewportToneSample();
      if (x === null) {
        return null;
      }
      return { x: x * 255, y: sampleCurveValue(lut(), x * 255) };
    });

    onMount(() => {
      const updateSize = () => {
        const width = Math.max(1, Math.round(svgRef.clientWidth));
        const height = Math.max(1, Math.round(svgRef.clientHeight));
        setSvgSize({ width, height });
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(svgRef);
      onCleanup(() => {
        observer.disconnect();
        clearCurveDragListeners?.();
      });
    });

    const svgCoords = (event: { clientX: number; clientY: number }) => {
      const point = svgRef.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = svgRef.getScreenCTM();
      if (!ctm) throw new Error("missing SVG screen transform");
      const local = point.matrixTransform(ctm.inverse());
      return {
        x: clamp(((local.x - graphPadding) / innerWidth()) * 255, 1, 254),
        y: clamp(1 - (local.y - graphPadding) / innerHeight(), 0, 1),
      };
    };

    const updateDraggingPoint = (clientX: number, clientY: number) => {
      const id = draggingId();
      if (id === null) {
        return;
      }
      const current = pts().find((point) => point.id === id);
      if (!current) {
        throw new Error("dragged curve point not found");
      }
      const nextCoords = svgCoords({ clientX, clientY });
      const { x, y } = isEndpointPoint(current)
        ? { x: current.x, y: clamp(nextCoords.y, 0, 1) }
        : normalizeInteriorPoint(nextCoords);
      const next = pts()
        .map((p) => (p.id === id ? { ...p, x, y } : p))
        .sort((a, b) => a.x - b.x);
      setPts(next);
      selectedAdjustmentLayerOrThrow();
      void applyCurves(next);
    };

    const finishDraggingPoint = () => {
      clearCurveDragListeners?.();
      clearCurveDragListeners = null;
      activeTouchId = null;
      setDraggingId(null);
    };

    const trackPointerDrag = (pointerId: number) => {
      clearCurveDragListeners?.();
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        updateDraggingPoint(event.clientX, event.clientY);
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        finishDraggingPoint();
      };
      const onPointerCancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        finishDraggingPoint();
        setHoveredId(null);
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      clearCurveDragListeners = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      };
    };

    const trackTouchDrag = (identifier: number) => {
      clearCurveDragListeners?.();
      const onTouchMove = (event: TouchEvent) => {
        const touch = findTouch(event.touches, identifier);
        if (!touch) {
          return;
        }
        event.preventDefault();
        updateDraggingPoint(touch.clientX, touch.clientY);
      };
      const onTouchEnd = (event: TouchEvent) => {
        const touch = findTouch(event.changedTouches, identifier);
        if (!touch) {
          return;
        }
        event.preventDefault();
        finishDraggingPoint();
      };
      const onTouchCancel = (event: TouchEvent) => {
        const touch = findTouch(event.changedTouches, identifier);
        if (!touch) {
          return;
        }
        finishDraggingPoint();
        setHoveredId(null);
      };
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd);
      window.addEventListener("touchcancel", onTouchCancel);
      clearCurveDragListeners = () => {
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("touchend", onTouchEnd);
        window.removeEventListener("touchcancel", onTouchCancel);
      };
    };

    const startNewPointDrag = (clientX: number, clientY: number) => {
      const { x, y } = normalizeInteriorPoint(svgCoords({ clientX, clientY }));
      const id = nextId++;
      const next = [...pts(), { x, y, id }].sort((a, b) => a.x - b.x);
      setPts(next);
      selectedAdjustmentLayerOrThrow();
      void applyCurves(next);
      setDraggingId(id);
    };

    const startExistingPointDrag = (id: number) => {
      const point = pts().find((candidate) => candidate.id === id);
      if (!point) {
        throw new Error("curve point not found");
      }
      setHoveredId(id);
      const now = Date.now();
      if (now - lastTapTime < 300 && lastTapId === id) {
        lastTapTime = 0;
        if (isEndpointPoint(point)) {
          const resetY = point.x === CURVE_MIN_X ? 0 : 1;
          const next = pts()
            .map((p) => (p.id === id ? { ...p, y: resetY } : p))
            .sort((a, b) => a.x - b.x);
          setPts(next);
          selectedAdjustmentLayerOrThrow();
          void applyCurves(next);
        } else {
          const next = pts().filter((p) => p.id !== id);
          setPts(next);
          selectedAdjustmentLayerOrThrow();
          void applyCurves(next);
        }
        finishDraggingPoint();
        setHoveredId(null);
        return false;
      }
      lastTapTime = now;
      lastTapId = id;
      setDraggingId(id);
      return true;
    };

    const findTouch = (touches: TouchList, identifier: number) => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) {
          return touch;
        }
      }
      return null;
    };

    return (
      <div
        data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
        class={`${PARAMETER_ROW_CLASS} mobile-slider-fade gap-y-1.5 transition-opacity duration-150`}
      >
        <span class="flex h-4 w-4 items-center justify-center text-[var(--text-subtle)] [&>svg]:h-4 [&>svg]:w-4" innerHTML={curveSvg} />
        <span class="self-center text-[13px] font-medium text-[var(--text-strong)]">
          Curves
        </span>
        <span class="self-center text-right text-xs font-medium tabular-nums text-[var(--text-value)]">
          Master
        </span>
        <div class="col-start-2 col-end-4 overflow-hidden">
          <svg
            ref={svgRef!}
            viewBox={`0 0 ${svgSize().width} ${svgSize().height}`}
            class="block h-36 min-h-[136px] w-full select-none"
            style={{
              cursor: draggingId() !== null ? "grabbing" : "crosshair",
              "touch-action": "none",
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (e.pointerType === "touch") return;
              if (e.target !== svgRef) return;
              e.preventDefault();
              startNewPointDrag(e.clientX, e.clientY);
              trackPointerDrag(e.pointerId);
            }}
            onPointerLeave={() => {
              setHoveredId(null);
            }}
            onTouchStart={(e) => {
              if (e.touches.length !== 1) {
                finishDraggingPoint();
                return;
              }
              const touch = e.touches.item(0);
              if (!touch) {
                throw new Error("curve touch interaction requires an active touch point");
              }
              activeTouchId = touch.identifier;
              if (e.target === svgRef) {
                e.preventDefault();
                startNewPointDrag(touch.clientX, touch.clientY);
                trackTouchDrag(touch.identifier);
              }
            }}
          >
            <rect
              x={graphPadding}
              y={graphPadding}
              width={innerWidth()}
              height={innerHeight()}
              fill="var(--curve-bg)"
              pointer-events="none"
            />
            {TONE_THRESHOLD_BOUNDARIES.map((boundary) => (
              <line
                x1={chartThresholdX(boundary.value)}
                y1={graphPadding}
                x2={chartThresholdX(boundary.value)}
                y2={graphPadding + innerHeight()}
                stroke="var(--curve-guide)"
                stroke-width="0.7"
                stroke-dasharray="4 6"
                opacity="0.5"
                pointer-events="none"
              />
            ))}
            <Show when={histogramSvgPath()}>
              {(path) => (
                <path
                  d={path()}
                  fill="var(--curve-stroke)"
                  fill-opacity="0.12"
                  stroke="none"
                  pointer-events="none"
                />
              )}
            </Show>
            <path
              d={`M ${graphPadding} ${graphPadding + innerHeight()} L ${
                graphPadding + innerWidth()
              } ${graphPadding}`}
              stroke="var(--curve-mid-line)"
              stroke-width="0.8"
              fill="none"
              pointer-events="none"
            />
            <path
              d={curveSvgPath()}
              stroke="var(--curve-stroke)"
              stroke-width="1.5"
              fill="none"
              pointer-events="none"
            />
            <Show when={hoveredToneGuide()}>
              {(guide) => (
                <>
                  <line
                    x1={chartX(guide().x)}
                    y1={graphPadding}
                    x2={chartX(guide().x)}
                    y2={graphPadding + innerHeight()}
                    stroke="var(--curve-guide-mid)"
                    stroke-width="1"
                    stroke-dasharray="4 4"
                    opacity="0.9"
                    pointer-events="none"
                  />
                  <circle
                    cx={chartX(guide().x)}
                    cy={chartY(guide().y)}
                    r="4"
                    fill="var(--curve-guide-mid)"
                    stroke="var(--curve-point-stroke)"
                    stroke-width="1.5"
                    pointer-events="none"
                  />
                </>
              )}
            </Show>
            {pts().map((pt) => (
              <>
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="7"
                  fill="none"
                  stroke="var(--curve-stroke)"
                  stroke-width="1.5"
                  opacity={hoveredId() === pt.id ? "0.75" : "0"}
                  pointer-events="none"
                />
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="14"
                  fill="transparent"
                  stroke="none"
                  style={{
                    cursor: draggingId() === pt.id ? "grabbing" : "grab",
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    if (e.touches.length !== 1) {
                      finishDraggingPoint();
                      return;
                    }
                    const touch = e.touches.item(0);
                    if (!touch) {
                      throw new Error(
                        "curve point touch interaction requires an active touch point",
                      );
                    }
                    activeTouchId = touch.identifier;
                    e.preventDefault();
                    if (!startExistingPointDrag(pt.id)) {
                      return;
                    }
                    trackTouchDrag(touch.identifier);
                  }}
                  onPointerDown={(e) => {
                    if (e.pointerType === "touch") return;
                    e.stopPropagation();
                    e.preventDefault();
                    if (!startExistingPointDrag(pt.id)) {
                      return;
                    }
                    trackPointerDrag(e.pointerId);
                  }}
                />
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="4.5"
                  fill="var(--curve-stroke)"
                  stroke="var(--curve-point-stroke)"
                  stroke-width="1.5"
                  style={{
                    cursor: draggingId() === pt.id ? "grabbing" : "grab",
                  }}
                  onPointerEnter={() => setHoveredId(pt.id)}
                  onPointerLeave={() =>
                    setHoveredId((current) => (current === pt.id ? null : current))
                  }
                  pointer-events="none"
                />
              </>
            ))}
          </svg>
        </div>
      </div>
    );
  };

  const HslSection: Component = () => {
    const accentColor = () => HSL_TAB_STYLES[hslTab()].accentColor;
    const hue = () => {
      const t = hslTab(),
        h = hsl();
      return t === "red" ? h.red_hue : t === "green" ? h.green_hue : h.blue_hue;
    };
    const sat = () => {
      const t = hslTab(),
        h = hsl();
      return t === "red" ? h.red_sat : t === "green" ? h.green_sat : h.blue_sat;
    };
    const lum = () => {
      const t = hslTab(),
        h = hsl();
      return t === "red" ? h.red_lum : t === "green" ? h.green_lum : h.blue_lum;
    };
    return (
      <div class="space-y-3">
        <div
          data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
          class={`${SEGMENTED_CONTROL_CLASS} mobile-slider-fade ml-4 grid-cols-3 transition-opacity duration-150`}
        >
          {(["red", "green", "blue"] as const).map((c) => (
            <Button
              type="button"
              onClick={() => setHslTab(c)}
              class={`${SEGMENT_BUTTON_CLASS} ${
                hslTab() === c
                  ? `bg-[var(--surface-active)] ${HSL_TAB_STYLES[c].tabClass}`
                  : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
              }`}
            >
              {c}
            </Button>
          ))}
        </div>
        <Slider
          label="Hue"
          icon={hslSvg}
          value={hue()}
          defaultValue={0}
          min={-1}
          max={1}
          step={0.01}
          accentColor={accentColor()}
          onChange={(v) => {
            selectedAdjustmentLayerOrThrow();
            void applyHsl(
              hslTab() === "red"
                ? { red_hue: v }
                : hslTab() === "green"
                  ? { green_hue: v }
                  : { blue_hue: v },
            );
          }}
        />
        <Slider
          label="Saturation"
          icon={dropletSvg}
          value={sat()}
          defaultValue={0}
          min={-1}
          max={1}
          step={0.01}
          accentColor={accentColor()}
          onChange={(v) => {
            selectedAdjustmentLayerOrThrow();
            void applyHsl(
              hslTab() === "red"
                ? { red_sat: v }
                : hslTab() === "green"
                  ? { green_sat: v }
                  : { blue_sat: v },
            );
          }}
        />
        <Slider
          label="Luminance"
          icon={toneSvg}
          value={lum()}
          defaultValue={0}
          min={-1}
          max={1}
          step={0.01}
          accentColor={accentColor()}
          onChange={(v) => {
            selectedAdjustmentLayerOrThrow();
            void applyHsl(
              hslTab() === "red"
                ? { red_lum: v }
                : hslTab() === "green"
                  ? { green_lum: v }
                  : { blue_lum: v },
            );
          }}
        />
      </div>
    );
  };

  const LsCurveEditor: Component = () => {
    const [draggingId, setDraggingId] = createSignal<number | null>(null);
    const [hoveredId, setHoveredId] = createSignal<number | null>(null);
    const [pts, setPts] = createSignal<EditableControlPoint[]>([]);
    const [svgSize, setSvgSize] = createSignal({ width: 100, height: 160 });
    const luminanceHistogram = createMemo(() => {
      const frame = backdropTile();
      return frame ? buildLuminanceHistogram(frame.image) : [];
    });
    let svgRef!: SVGSVGElement;
    let nextId = 0;
    let lastTapTime = 0;
    let lastTapId = -1;
    let activeTouchId: number | null = null;
    let clearCurveDragListeners: (() => void) | null = null;

    createEffect(
      on(
        () => state.selectedLayerIdx,
        (layerIdx) => {
          const layer = state.layers[layerIdx];
          if (layer?.kind !== "adjustment") {
            setPts([]);
            setDraggingId(null);
            setHoveredId(null);
            return;
          }
          const points =
            lsCurvePointCache().get(layerIdx) ??
            layer.adjustments?.ls_curve?.control_points ??
            defaultLsCurvePoints();
          nextId = 0;
          setPts(
            normalizeLsPoints(points.length === 0 ? defaultLsCurvePoints() : points).map(
              (point) => ({
                ...point,
                id: nextId++,
              }),
            ),
          );
          setDraggingId(null);
          setHoveredId(null);
        },
      ),
    );

    const lut = () => buildLsCurveLutFromPoints(pts());
    const graphPadding = 0;
    const innerWidth = () => Math.max(1, svgSize().width - graphPadding * 2);
    const innerHeight = () => Math.max(1, svgSize().height - graphPadding * 2);
    const chartX = (value: number) => graphPadding + (value / 255) * innerWidth();
    const chartY = (value: number) => graphPadding + (2 - value) * innerHeight() * 0.5;
    const chartThresholdX = (value: number) => graphPadding + value * innerWidth();
    const curveSvgPath = () =>
      remapPath(lsCurvePath(lut()), svgSize().width, svgSize().height, graphPadding);
    const histogramSvgPath = () =>
      remapPath(
        histogramPath(luminanceHistogram()),
        svgSize().width,
        svgSize().height,
        graphPadding,
      );

    onMount(() => {
      const updateSize = () => {
        const width = Math.max(1, Math.round(svgRef.clientWidth));
        const height = Math.max(1, Math.round(svgRef.clientHeight));
        setSvgSize({ width, height });
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(svgRef);
      onCleanup(() => {
        observer.disconnect();
        clearCurveDragListeners?.();
      });
    });

    const svgCoords = (event: { clientX: number; clientY: number }) => {
      const point = svgRef.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = svgRef.getScreenCTM();
      if (!ctm) throw new Error("missing SVG screen transform");
      const local = point.matrixTransform(ctm.inverse());
      return {
        x: clamp(((local.x - graphPadding) / innerWidth()) * 255, 1, 254),
        y: clamp(2 - ((local.y - graphPadding) / innerHeight()) * 2, 0, 2),
      };
    };

    const updateDraggingPoint = (clientX: number, clientY: number) => {
      const id = draggingId();
      if (id === null) {
        return;
      }
      const current = pts().find((point) => point.id === id);
      if (!current) {
        throw new Error("dragged curve point not found");
      }
      const nextCoords = svgCoords({ clientX, clientY });
      const { x, y } = isEndpointPoint(current)
        ? { x: current.x, y: clamp(nextCoords.y, 0, 2) }
        : normalizeLsInteriorPoint(nextCoords);
      const next = pts()
        .map((p) => (p.id === id ? { ...p, x, y } : p))
        .sort((a, b) => a.x - b.x);
      setPts(next);
      selectedAdjustmentLayerOrThrow();
      void applyLsCurve(next);
    };

    const finishDraggingPoint = () => {
      clearCurveDragListeners?.();
      clearCurveDragListeners = null;
      activeTouchId = null;
      setDraggingId(null);
    };

    const trackPointerDrag = (pointerId: number) => {
      clearCurveDragListeners?.();
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        updateDraggingPoint(event.clientX, event.clientY);
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        finishDraggingPoint();
      };
      const onPointerCancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) {
          return;
        }
        finishDraggingPoint();
        setHoveredId(null);
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      clearCurveDragListeners = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      };
    };

    const trackTouchDrag = (identifier: number) => {
      clearCurveDragListeners?.();
      const onTouchMove = (event: TouchEvent) => {
        const touch = findTouch(event.touches, identifier);
        if (!touch) {
          return;
        }
        event.preventDefault();
        updateDraggingPoint(touch.clientX, touch.clientY);
      };
      const onTouchEnd = (event: TouchEvent) => {
        const touch = findTouch(event.changedTouches, identifier);
        if (!touch) {
          return;
        }
        event.preventDefault();
        finishDraggingPoint();
      };
      const onTouchCancel = (event: TouchEvent) => {
        const touch = findTouch(event.changedTouches, identifier);
        if (!touch) {
          return;
        }
        finishDraggingPoint();
        setHoveredId(null);
      };
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd);
      window.addEventListener("touchcancel", onTouchCancel);
      clearCurveDragListeners = () => {
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("touchend", onTouchEnd);
        window.removeEventListener("touchcancel", onTouchCancel);
      };
    };

    const startNewPointDrag = (clientX: number, clientY: number) => {
      const { x, y } = normalizeLsInteriorPoint(svgCoords({ clientX, clientY }));
      const id = nextId++;
      const next = [...pts(), { x, y, id }].sort((a, b) => a.x - b.x);
      setPts(next);
      selectedAdjustmentLayerOrThrow();
      void applyLsCurve(next);
      setDraggingId(id);
    };

    const startExistingPointDrag = (id: number) => {
      const point = pts().find((candidate) => candidate.id === id);
      if (!point) {
        throw new Error("curve point not found");
      }
      setHoveredId(id);
      const now = Date.now();
      if (now - lastTapTime < 300 && lastTapId === id) {
        lastTapTime = 0;
        if (isEndpointPoint(point)) {
          const next = pts()
            .map((p) => (p.id === id ? { ...p, y: 1 } : p))
            .sort((a, b) => a.x - b.x);
          setPts(next);
          selectedAdjustmentLayerOrThrow();
          void applyLsCurve(next);
        } else {
          const next = pts().filter((p) => p.id !== id);
          setPts(next);
          selectedAdjustmentLayerOrThrow();
          void applyLsCurve(next);
        }
        finishDraggingPoint();
        setHoveredId(null);
        return false;
      }
      lastTapTime = now;
      lastTapId = id;
      setDraggingId(id);
      return true;
    };

    const findTouch = (touches: TouchList, identifier: number) => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) {
          return touch;
        }
      }
      return null;
    };

    return (
      <div
        data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
        class={`${PARAMETER_ROW_CLASS} mobile-slider-fade gap-y-1.5 transition-opacity duration-150`}
      >
        <span class="flex h-4 w-4 items-center justify-center text-[var(--text-subtle)] [&>svg]:h-4 [&>svg]:w-4" innerHTML={curveSvg} />
        <span class="self-center text-[13px] font-medium text-[var(--text-strong)]">
          LS Curve
        </span>
        <span class="self-center text-right text-xs font-medium tabular-nums text-[var(--text-value)]">
          Lum-Sat
        </span>
        <div class="col-start-2 col-end-4 overflow-hidden">
          <svg
            ref={svgRef!}
            viewBox={`0 0 ${svgSize().width} ${svgSize().height}`}
            class="block h-36 min-h-[136px] w-full select-none"
            style={{
              cursor: draggingId() !== null ? "grabbing" : "crosshair",
              "touch-action": "none",
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (e.pointerType === "touch") return;
              if (e.target !== svgRef) return;
              e.preventDefault();
              startNewPointDrag(e.clientX, e.clientY);
              trackPointerDrag(e.pointerId);
            }}
            onPointerLeave={() => {
              setHoveredId(null);
            }}
            onTouchStart={(e) => {
              if (e.touches.length !== 1) {
                finishDraggingPoint();
                return;
              }
              const touch = e.touches.item(0);
              if (!touch) {
                throw new Error("curve touch interaction requires an active touch point");
              }
              activeTouchId = touch.identifier;
              if (e.target === svgRef) {
                e.preventDefault();
                startNewPointDrag(touch.clientX, touch.clientY);
                trackTouchDrag(touch.identifier);
              }
            }}
          >
            <rect
              x={graphPadding}
              y={graphPadding}
              width={innerWidth()}
              height={innerHeight()}
              fill="var(--curve-bg)"
              pointer-events="none"
            />
            {TONE_THRESHOLD_BOUNDARIES.map((boundary) => (
              <line
                x1={chartThresholdX(boundary.value)}
                y1={graphPadding}
                x2={chartThresholdX(boundary.value)}
                y2={graphPadding + innerHeight()}
                stroke="var(--curve-guide)"
                stroke-width="0.7"
                stroke-dasharray="4 6"
                opacity="0.5"
                pointer-events="none"
              />
            ))}
            <Show when={histogramSvgPath()}>
              {(path) => (
                <path
                  d={path()}
                  fill="var(--curve-stroke)"
                  fill-opacity="0.12"
                  stroke="none"
                  pointer-events="none"
                />
              )}
            </Show>
            <path
              d={`M ${graphPadding} ${graphPadding + innerHeight() * 0.5} L ${
                graphPadding + innerWidth()
              } ${graphPadding + innerHeight() * 0.5}`}
              stroke="var(--curve-mid-line)"
              stroke-width="0.8"
              fill="none"
              pointer-events="none"
            />
            <path
              d={curveSvgPath()}
              stroke="var(--curve-stroke)"
              stroke-width="1.5"
              fill="none"
              pointer-events="none"
            />
            {pts().map((pt) => (
              <>
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="7"
                  fill="none"
                  stroke="var(--curve-stroke)"
                  stroke-width="1.5"
                  opacity={hoveredId() === pt.id ? "0.75" : "0"}
                  pointer-events="none"
                />
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="14"
                  fill="transparent"
                  stroke="none"
                  style={{
                    cursor: draggingId() === pt.id ? "grabbing" : "grab",
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    if (e.touches.length !== 1) {
                      finishDraggingPoint();
                      return;
                    }
                    const touch = e.touches.item(0);
                    if (!touch) {
                      throw new Error(
                        "curve point touch interaction requires an active touch point",
                      );
                    }
                    activeTouchId = touch.identifier;
                    e.preventDefault();
                    if (!startExistingPointDrag(pt.id)) {
                      return;
                    }
                    trackTouchDrag(touch.identifier);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if (e.pointerType === "touch") return;
                    e.stopPropagation();
                    if (!startExistingPointDrag(pt.id)) {
                      return;
                    }
                    trackPointerDrag(e.pointerId);
                  }}
                />
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="3.5"
                  fill={
                    isEndpointPoint(pt) ? "var(--curve-endpoint)" : "var(--curve-point)"
                  }
                  pointer-events="none"
                />
              </>
            ))}
          </svg>
          <div class="mt-1 flex justify-between px-1">
            <span class="text-[10px] text-[var(--text-faint)]">Lum</span>
            <span class="text-[10px] text-[var(--text-faint)]">Sat</span>
          </div>
        </div>
      </div>
    );
  };

  const LightSliders: Component = () => (
    <>
      <Slider
        label="Exposure"
        icon={sparkSvg}
        value={tone().exposure}
        defaultValue={DEFAULT_TONE.exposure}
        min={-5}
        max={5}
        step={0.05}
        onChange={(v) => applyTone({ exposure: v })}
      />
      <Slider
        label="Gamma"
        icon={toneSvg}
        value={tone().gamma}
        defaultValue={DEFAULT_TONE.gamma}
        min={0.1}
        max={3}
        onChange={(v) => applyTone({ gamma: v })}
      />
      <Slider
        label="Contrast"
        icon={circleSvg}
        value={tone().contrast}
        defaultValue={DEFAULT_TONE.contrast}
        min={-1.0}
        max={1.0}
        step={0.01}
        onChange={(v) => applyTone({ contrast: v })}
      />
    </>
  );

  const LevelSliders: Component = () => (
    <>
      <Slider
        label="Blacks"
        icon={toneSvg}
        value={tone().blacks}
        defaultValue={DEFAULT_TONE.blacks}
        min={-0.05}
        max={0.1}
        step={0.001}
        onChange={(v) => applyTone({ blacks: v })}
      />
      <Slider
        label="Whites"
        icon={toneSvg}
        value={tone().whites}
        defaultValue={DEFAULT_TONE.whites}
        min={-0.1}
        max={0.2}
        step={0.001}
        onChange={(v) => applyTone({ whites: v })}
      />
    </>
  );

  const SaturationSliders: Component = () => (
    <>
      <Slider
        label="Saturation"
        icon={dropletSvg}
        value={color().saturation}
        defaultValue={DEFAULT_COLOR.saturation}
        valueLabel={valueLabel(color().saturation)}
        min={0}
        max={2}
        onChange={(v) => applyColor({ saturation: v })}
      />
      <Slider
        label="Vibrancy"
        icon={dropletSvg}
        value={color().vibrancy}
        defaultValue={DEFAULT_COLOR.vibrancy}
        valueLabel={valueLabel(color().vibrancy)}
        min={-1}
        max={1}
        onChange={(v) => applyColor({ vibrancy: v })}
      />
    </>
  );

  const WhiteBalanceSliders: Component = () => (
    <>
      <Slider
        label="Temperature"
        icon={toneSvg}
        value={color().temperature}
        defaultValue={DEFAULT_COLOR.temperature}
        valueLabel={valueLabel(color().temperature)}
        min={-1}
        max={1}
        onChange={(v) => applyColor({ temperature: v })}
      />
      <Slider
        label="Tint"
        icon={toneSvg}
        value={color().tint}
        defaultValue={DEFAULT_COLOR.tint}
        valueLabel={valueLabel(color().tint)}
        min={-1}
        max={1}
        onChange={(v) => applyColor({ tint: v })}
      />
    </>
  );

  const GrainSliders: Component = () => (
    <>
      <Slider
        label="Grain"
        icon={grainSvg}
        value={grain().amount}
        defaultValue={DEFAULT_GRAIN.amount}
        valueLabel={valueLabel(grain().amount)}
        min={0}
        max={1}
        onChange={(v) => {
          selectedAdjustmentLayerOrThrow();
          void applyEdit({
            layer_idx: state.selectedLayerIdx,
            op: "grain",
            grain_amount: v,
          });
        }}
      />
      <Slider
        label="Size"
        icon={grainSvg}
        value={grain().size ?? DEFAULT_GRAIN.size}
        defaultValue={DEFAULT_GRAIN.size}
        valueLabel={`${(grain().size ?? DEFAULT_GRAIN.size).toFixed(1)}`}
        min={1}
        max={8}
        step={0.01}
        onChange={(v) => {
          selectedAdjustmentLayerOrThrow();
          void applyEdit({
            layer_idx: state.selectedLayerIdx,
            op: "grain",
            grain_size: v,
          });
        }}
      />
    </>
  );

  const VignetteSlider: Component = () => (
    <Slider
      label="Vignette"
      icon={circleSvg}
      value={vignette().amount}
      defaultValue={DEFAULT_VIGNETTE.amount}
      valueLabel={valueLabel(vignette().amount)}
      min={0}
      max={1}
      onChange={(v) => {
        selectedAdjustmentLayerOrThrow();
        void applyEdit({
          layer_idx: state.selectedLayerIdx,
          op: "vignette",
          vignette_amount: v,
        });
      }}
    />
  );

  const GlowSlider: Component = () => (
    <Slider
      label="Glow"
      icon={sparkSvg}
      value={glow().amount}
      defaultValue={DEFAULT_GLOW.amount}
      valueLabel={valueLabel(glow().amount)}
      min={0}
      max={1}
      onChange={(v) => {
        selectedAdjustmentLayerOrThrow();
        void applyEdit({
          layer_idx: state.selectedLayerIdx,
          op: "glow",
          glow_amount: v,
        });
      }}
    />
  );

  const SharpenSlider: Component = () => (
    <Slider
      label="Sharpen"
      icon={dropletSvg}
      value={sharpen().amount}
      defaultValue={DEFAULT_SHARPEN.amount}
      valueLabel={valueLabel(sharpen().amount)}
      min={0}
      max={1}
      onChange={(v) => {
        selectedAdjustmentLayerOrThrow();
        void applyEdit({
          layer_idx: state.selectedLayerIdx,
          op: "sharpen",
          sharpen_amount: v,
        });
      }}
    />
  );

  const DenoiseSliders: Component = () => (
    <>
      <Slider
        label="Luminance"
        icon={denoiseSvg}
        value={denoise().luma_strength}
        defaultValue={DEFAULT_DENOISE.luma_strength}
        valueLabel={valueLabel(denoise().luma_strength)}
        min={0}
        max={1}
        onChange={(v) => {
          selectedAdjustmentLayerOrThrow();
          void applyEdit({
            layer_idx: state.selectedLayerIdx,
            op: "denoise",
            denoise_luma_strength: v,
            denoise_chroma_strength: denoise().chroma_strength,
            denoise_mode: denoise().mode,
          });
        }}
      />
      <Slider
        label="Color"
        icon={denoiseSvg}
        value={denoise().chroma_strength}
        defaultValue={DEFAULT_DENOISE.chroma_strength}
        valueLabel={valueLabel(denoise().chroma_strength)}
        min={0}
        max={1}
        onChange={(v) => {
          selectedAdjustmentLayerOrThrow();
          void applyEdit({
            layer_idx: state.selectedLayerIdx,
            op: "denoise",
            denoise_luma_strength: denoise().luma_strength,
            denoise_chroma_strength: v,
            denoise_mode: denoise().mode,
          });
        }}
      />
    </>
  );

  const adjustmentLayers = () =>
    state.layers
      .map((layer, idx) => ({ layer, idx }))
      .filter(({ layer }) => layer.kind === "adjustment");

  const resolvedLayerFocus = (idx: number): MobileLayerFocus =>
    idx === state.selectedLayerIdx && pendingAddedLayerFocus() !== null
      ? pendingAddedLayerFocus()!
      : (layerFocusOverrides().get(idx) ?? inferFocus(state.layers[idx]));

  const selectedFocus = (): MobileLayerFocus =>
    resolvedLayerFocus(state.selectedLayerIdx);

  const displayedCrop = () =>
    selectedCropLayer()?.crop ?? {
      x: 0,
      y: 0,
      width: state.canvasWidth,
      height: state.canvasHeight,
      rotation: 0,
    };
  const imageDetails = () => {
    const artboard = selectedArtboard();
    if (!artboard) {
      throw new Error("image details require a selected artboard");
    }
    const source = imageSourceDetail(artboard.source);
    return {
      ...source,
      dimensions: `${artboard.width} × ${artboard.height}`,
      bitDepth: artboard.sourceBitDepth,
      colorSpace: state.previewDisplayColorSpace,
    };
  };
  const setCropField = (
    field: "x" | "y" | "width" | "height" | "rotation",
    value: number,
  ) => {
    if (!Number.isFinite(value)) {
      throw new Error(`crop ${field} must be a finite number`);
    }
    const crop = displayedCrop();
    if (!selectedCropLayer()) {
      throw new Error("crop controls require a selected crop layer");
    }
    void applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "crop",
      crop_x: field === "x" ? value : crop.x,
      crop_y: field === "y" ? value : crop.y,
      crop_width: field === "width" ? value : crop.width,
      crop_height: field === "height" ? value : crop.height,
      crop_rotation: field === "rotation" ? value : crop.rotation,
    });
  };

  const handleAddLayer = async (focus: MobileLayerFocus) => {
    setIsPickerOpen(false);
    setPendingAddedLayerFocus(focus);
    try {
      const newIdx =
        focus === "curves"
          ? await addLayer("curves", state.layers.length)
          : focus === "ls_curve"
            ? await addLayer("ls_curve", state.layers.length)
            : await addLayer("adjustment", state.layers.length);
      setLayerFocusOverrides((prev) => new Map(prev).set(newIdx, focus));
      selectLayer(newIdx);
      setIsDrawerOpen(true);
    } finally {
      setPendingAddedLayerFocus(null);
    }
  };

  const handleApplyLinearMask = async (idx: number) => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    await applyGradientMask({
      kind: "linear",
      layer_idx: idx,
      x1: 0,
      y1: 0,
      x2: 0,
      y2: h,
    });
    setMaskPickerLayer(null);
  };

  const handleApplyRadialMask = async (idx: number) => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    await applyGradientMask({
      kind: "radial",
      layer_idx: idx,
      cx: w / 2,
      cy: h / 2,
      radius: Math.min(w, h) / 2,
    });
    setMaskPickerLayer(null);
  };

  const handleApplyBrushMask = async (idx: number) => {
    await createBrushMask(idx);
    setMaskPickerLayer(null);
  };

  const handleRemoveMask = async (idx: number) => {
    await removeMask(idx);
  };

  const handleDeleteSelectedLayer = async () => {
    if (state.selectedLayerIdx < 0) {
      throw new Error("cannot delete without a selected layer");
    }
    if (state.layers[state.selectedLayerIdx]?.kind === "image") {
      throw new Error("cannot delete the image layer");
    }
    await deleteLayer(state.selectedLayerIdx);
  };

  const topLayerInsertPosition = () => state.layers.length;

  const cropLayerInsertPosition = () => {
    const imageLayerIdx = state.layers.findIndex((layer) => layer.kind === "image");
    if (imageLayerIdx < 0) {
      throw new Error("cannot add a crop layer without an image layer");
    }
    return imageLayerIdx + 1;
  };

  const refreshPresetList = async () => {
    try {
      setPresets(await listPresets());
      setSnapshots(await listSnapshots());
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const formatSnapshotDate = (createdAt: number) => new Date(createdAt).toLocaleString();

  createEffect(
    on(
      () => state.layers.length,
      () => {
        const idx = editingLayerIdx();
        if (idx === null) {
          return;
        }
        if (idx < state.layers.length) {
          return;
        }
        setEditingLayerIdx(null);
        setEditingLayerName("");
      },
    ),
  );

  createEffect(() => {
    if (inspectorTab() !== "presets") return;
    void refreshPresetList();
  });

  const nextPresetName = () => {
    const existing = new Set(presets().map((p) => p.name));
    let idx = existing.size + 1;
    while (existing.has(`Preset ${idx}`)) idx++;
    return `Preset ${idx}`;
  };

  const handleSavePreset = async () => {
    const name = nextPresetName();
    setIsPresetBusy(true);
    try {
      await savePreset(name);
      await refreshPresetList();
      setEditingPresetName(name);
      setEditingPresetValue(name);
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };

  const handleLoadPreset = async (name: string) => {
    setIsPresetBusy(true);
    try {
      await loadPreset(name);
      setPresetStatus(`Loaded ${name}`);
      await refreshPresetList();
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };

  const handleRenamePreset = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingPresetName(null);
      return;
    }
    setIsPresetBusy(true);
    try {
      await renamePreset(oldName, trimmed);
      await refreshPresetList();
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
      setEditingPresetName(null);
    }
  };

  const handleLoadSnapshot = async (id: string) => {
    setIsPresetBusy(true);
    try {
      await loadSnapshot(id);
      setPresetStatus(`Loaded snapshot`);
      await refreshPresetList();
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };

  const handleSaveSnapshot = async () => {
    setIsPresetBusy(true);
    try {
      await saveSnapshot();
      setPresetStatus(`Saved snapshot`);
      await refreshPresetList();
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };

  const MobileLayerBody: Component = () => {
    return (
      <Switch>
        <Match when={selectedFocus() === "light"}>
          <LightSliders />
        </Match>
        <Match when={selectedFocus() === "levels"}>
          <LevelSliders />
        </Match>
        <Match when={selectedFocus() === "color"}>
          <SaturationSliders />
        </Match>
        <Match when={selectedFocus() === "wb"}>
          <WhiteBalanceSliders />
        </Match>
        <Match when={selectedFocus() === "curves"}>
          <CurvesEditor />
        </Match>
        <Match when={selectedFocus() === "ls_curve"}>
          <LsCurveEditor />
        </Match>
        <Match when={selectedFocus() === "grain"}>
          <GrainSliders />
        </Match>
        <Match when={selectedFocus() === "glow"}>
          <GlowSlider />
        </Match>
        <Match when={selectedFocus() === "vignette"}>
          <VignetteSlider />
        </Match>
        <Match when={selectedFocus() === "sharpen"}>
          <SharpenSlider />
        </Match>
        <Match when={selectedFocus() === "hsl"}>
          <HslSection />
        </Match>
        <Match when={selectedFocus() === "denoise"}>
          <DenoiseSliders />
        </Match>
      </Switch>
    );
  };

  const startInlineLayerRename = (idx: number) => {
    const layer = state.layers[idx];
    if (!layer) {
      throw new Error("cannot rename a missing layer");
    }
    selectLayer(idx);
    setEditingLayerIdx(idx);
    setEditingLayerName(layer.name ?? "");
  };

  const cancelInlineLayerRename = () => {
    setEditingLayerIdx(null);
    setEditingLayerName("");
  };

  const commitInlineLayerRename = async () => {
    const idx = editingLayerIdx();
    if (idx === null) {
      return;
    }
    const layer = state.layers[idx];
    const nextName = editingLayerName().trim();
    const normalizedName = nextName.length > 0 ? nextName : null;
    cancelInlineLayerRename();
    if (!layer) {
      return;
    }
    if ((layer.name ?? null) === normalizedName) {
      return;
    }
    await renameLayer(idx, normalizedName);
  };

  const CropPanel: Component = () => {
    const crop = () => displayedCrop();
    const hasCropLayer = () => findCropLayerIdx() >= 0;

    return (
      <div class="flex flex-col gap-3">
        <div class={`${PARAMETER_ROW_CLASS} py-0`}>
          <span class="flex h-4 w-4 items-center justify-center text-[var(--text-icon)] [&>svg]:h-4 [&>svg]:w-4" innerHTML={cropSvg} />
          <span class="self-center text-[13px] font-medium text-[var(--text-strong)]">
            Crop
          </span>
          <span class="self-center text-right text-xs font-medium tabular-nums text-[var(--text-value)]">
            {crop().width} × {crop().height}
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          {(["x", "y", "width", "height"] as const).map((field) => (
            <label class="flex flex-col gap-1">
              <span class={SECTION_TITLE_CLASS}>{field}</span>
              <input
                type="number"
                value={crop()[field]}
                disabled={!selectedCropLayer()}
                min="0"
                step="1"
                onInput={(event) =>
                  setCropField(field, event.currentTarget.valueAsNumber)
                }
                class={INPUT_CLASS}
              />
            </label>
          ))}
          <label class="col-span-2 flex flex-col gap-1">
            <span class={SECTION_TITLE_CLASS}>Rotation</span>
            <input
              type="number"
              value={Math.round(((crop().rotation * 180) / Math.PI) * 10) / 10}
              disabled={!selectedCropLayer()}
              step="0.5"
              onInput={(event) =>
                setCropField(
                  "rotation",
                  (event.currentTarget.valueAsNumber * Math.PI) / 180,
                )
              }
              class={INPUT_CLASS}
            />
          </label>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show
            when={selectedCropLayer()}
            fallback={
              <Button
                type="button"
                onClick={() => {
                  const cropLayerIdx = findCropLayerIdx();
                  if (cropLayerIdx >= 0) {
                    selectLayer(cropLayerIdx);
                    return;
                  }
                  void addLayer("crop", cropLayerInsertPosition());
                }}
                class={SECONDARY_BUTTON_CLASS}
              >
                {hasCropLayer() ? "Select crop" : "Add crop layer"}
              </Button>
            }
          >
            <Button
              type="button"
              onClick={() => setCropField("x", 0)}
              class={SECONDARY_BUTTON_CLASS}
            >
              Align left
            </Button>
            <Button
              type="button"
              onClick={() => {
                void applyEdit({
                  layer_idx: state.selectedLayerIdx,
                  op: "crop",
                  crop_x: 0,
                  crop_y: 0,
                  crop_width: state.canvasWidth,
                  crop_height: state.canvasHeight,
                  crop_rotation: 0,
                });
              }}
              class={SECONDARY_BUTTON_CLASS}
            >
              Reset
            </Button>
          </Show>
        </div>
      </div>
    );
  };

  const ImageInfoPanel: Component = () => {
    const details = () => imageDetails();
    return (
      <div class="flex flex-col gap-4 pt-1">
        <SectionHeader title="Image" />
        <div class="flex flex-col gap-2 rounded-lg bg-[var(--surface-subtle)] p-3 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
          {(
            [
              { label: "Filename", value: details().filename },
              { label: "Location", value: details().location },
              { label: "Source", value: details().source },
              { label: "Dimensions", value: details().dimensions },
              { label: "Bit Depth", value: details().bitDepth },
              { label: "Color Space", value: details().colorSpace },
            ] as const
          ).map((item) => (
            <div class="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1">
              <div class={SECTION_TITLE_CLASS}>{item.label}</div>
              <div class="min-w-0 break-words text-[13px] font-medium text-[var(--text-strong)]">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const PresetsPanel: Component = () => (
    <div class="flex flex-col gap-5 pt-1">
      <section class="flex flex-col gap-3">
        <SectionHeader
          title="Presets"
          detail={presets().length > 0 ? () => `${presets().length}` : undefined}
        />
        <Button
          type="button"
          disabled={isPresetBusy() || state.canvasWidth <= 0}
          onClick={() => void handleSavePreset()}
          class={SECONDARY_BUTTON_CLASS}
        >
          Save Preset
        </Button>
        <Show when={presetStatus()}>
          {(status) => (
            <div class="rounded-md bg-[var(--surface-subtle)] px-2 py-2 text-xs font-medium text-[var(--text-value)] shadow-[inset_0_0_0_1px_var(--border-subtle)]">
              {status()}
            </div>
          )}
        </Show>
        <Show
          when={presets().length > 0}
          fallback={<EmptyState>No presets saved yet.</EmptyState>}
        >
          <div class="flex flex-col gap-1">
            {presets().map((preset) => (
              <div class="grid min-h-8 grid-cols-[minmax(0,1fr)_72px] items-center gap-2 rounded-md bg-[var(--surface-subtle)] px-2 py-1.5 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
                <div class="min-w-0">
                  <Show
                    when={editingPresetName() === preset.name}
                    fallback={
                      <div
                        class="truncate text-[13px] font-medium text-[var(--text-strong)] cursor-default"
                        onDblClick={() => {
                          setEditingPresetName(preset.name);
                          setEditingPresetValue(preset.name);
                        }}
                      >
                        {preset.name}
                      </div>
                    }
                  >
                    <input
                      ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
                      type="text"
                      value={editingPresetValue()}
                      onInput={(e) => setEditingPresetValue(e.currentTarget.value)}
                      onBlur={() => void handleRenamePreset(preset.name, editingPresetValue())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          setEditingPresetName(null);
                        }
                      }}
                      class={`min-w-0 ${INPUT_CLASS}`}
                    />
                  </Show>
                </div>
                <Button
                  type="button"
                  disabled={isPresetBusy() || state.canvasWidth <= 0}
                  onClick={() => void handleLoadPreset(preset.name)}
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Load
                </Button>
              </div>
            ))}
          </div>
        </Show>
      </section>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <SectionHeader
            title="Image Snapshots"
            detail={snapshots().length > 0 ? () => `${snapshots().length}` : undefined}
          />
          <Button
            type="button"
            disabled={isPresetBusy() || state.canvasWidth <= 0}
            onClick={() => void handleSaveSnapshot()}
            class={SECONDARY_BUTTON_CLASS}
          >
            Save
          </Button>
        </div>
        <Show
          when={snapshots().length > 0}
          fallback={<EmptyState>No snapshots yet.</EmptyState>}
        >
          <div class="flex flex-col gap-1">
            {snapshots().map((snapshot) => (
              <div class="grid min-h-8 grid-cols-[minmax(0,1fr)_auto_72px] items-center gap-2 rounded-md bg-[var(--surface-subtle)] px-2 py-1.5 shadow-[inset_0_0_0_1px_var(--border-subtle)]">
                <div class="min-w-0">
                  <div class="truncate text-[13px] font-medium text-[var(--text-strong)]">
                    {`Version ${snapshot.display_index}`}
                  </div>
                  <div class="text-[11px] text-[var(--text-faint)]">
                    {formatSnapshotDate(snapshot.created_at)}
                  </div>
                </div>
                <Show when={snapshot.is_current}>
                  <div class="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-value)]">
                    Current
                  </div>
                </Show>
                <Button
                  type="button"
                  disabled={
                    isPresetBusy() || state.canvasWidth <= 0 || snapshot.is_current
                  }
                  onClick={() => void handleLoadSnapshot(snapshot.id)}
                  class={SECONDARY_BUTTON_CLASS}
                >
                  Load
                </Button>
              </div>
            ))}
          </div>
        </Show>
      </section>
    </div>
  );

  const InspectorTabs: Component<{ class?: string }> = (props) => (
    <div
      data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
      class={`${props.class ?? ""} mobile-slider-fade transition-opacity duration-150`}
    >
      <div class={`${SEGMENTED_CONTROL_CLASS} grid-cols-2`}>
        {(["edit", "presets"] as const).map((tab) => (
          <Button
            type="button"
            onClick={() => setInspectorTab(tab)}
            class={`${SEGMENT_BUTTON_CLASS} ${
              inspectorTab() === tab
                ? "bg-[var(--surface-selected)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border-active)]"
                : "text-[var(--text-faint)] hover:text-[var(--text-strong)]"
            }`}
          >
            {tab}
          </Button>
        ))}
      </div>
    </div>
  );

  const DesktopLayerList: Component = () => (
    <div
      data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
      class="mobile-slider-fade flex flex-col gap-3 transition-opacity duration-150"
    >
      <div ref={desktopLayerListRef} class="relative flex flex-col gap-1">
        <div
          class="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 -translate-y-1/2 rounded-full bg-[var(--text)]"
          style={getDesktopDropCursorStyle()}
        />
        <Button
          type="button"
          onClick={() => void addLayer("adjustment", topLayerInsertPosition())}
          class={ADD_LAYER_ROW_CLASS}
        >
          <span />
          <span class="inline-flex h-4 w-4 items-center justify-center text-[12px] leading-none text-[var(--text-dim)]">
            +
          </span>
          <span />
          <span>Add Adjustment</span>
          <span />
          <span />
        </Button>
        {[...state.layers].reverse().map((layer, reverseIdx) => {
          const realIdx = state.layers.length - 1 - reverseIdx;
          return (
            <>
              <Show when={layer.kind === "image"}>
                <Button
                  type="button"
                  onClick={() => void addLayer("crop", cropLayerInsertPosition())}
                  class={ADD_LAYER_ROW_CLASS}
                >
                  <span />
                  <span class="inline-flex h-4 w-4 items-center justify-center text-[12px] leading-none text-[var(--text-dim)]">
                    +
                  </span>
                  <span />
                  <span>Add Crop</span>
                  <span />
                  <span />
                </Button>
              </Show>
              <div
                data-layer-idx={realIdx}
                class={`${LAYER_ROW_CLASS} ${
                  state.selectedLayerIdx === realIdx
                    ? "bg-[var(--surface-active)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border-active)]"
                    : "bg-[var(--surface-subtle)] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-subtle)] hover:bg-[var(--surface)]"
                } ${draggedLayerIdx() === realIdx ? "opacity-45" : ""}`}
              >
                <Show
                  when={layer.kind !== "image"}
                  fallback={<span />}
                >
                  <Button
                    type="button"
                    onPointerDown={(event) => startDesktopLayerDrag(event, realIdx)}
                    class="inline-flex h-4 w-4 cursor-grab items-center justify-center text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)] active:cursor-grabbing"
                    title="Reorder layer"
                  >
                    <span class="grid grid-cols-2 gap-[2px]">
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                      <span class="h-0.5 w-0.5 rounded-full bg-current" />
                    </span>
                  </Button>
                </Show>
                <Show
                  when={layer.kind !== "image"}
                  fallback={<span />}
                >
                  <button
                    type="button"
                    class={`inline-flex h-4 w-4 items-center justify-center text-xs leading-none transition-colors ${
                      layer.visible ? "text-[var(--text)]" : "text-[var(--text-subtle)]"
                    }`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void setLayerVisible(realIdx, !layer.visible);
                    }}
                  >
                    {layer.visible ? "●" : "○"}
                  </button>
                </Show>
                <span class="flex h-4 w-4 items-center justify-center text-[var(--text-dim)] [&>svg]:h-4 [&>svg]:w-4">
                  <LayerTypeIcon layer={layer} />
                </span>
                <Show
                  when={editingLayerIdx() === realIdx}
                  fallback={
                    <Button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => selectLayer(realIdx)}
                      onDblClick={(event) => {
                        event.stopPropagation();
                        startInlineLayerRename(realIdx);
                      }}
                      class="min-w-0 truncate py-1 text-left text-[13px] font-medium focus-visible:outline-none"
                    >
                      {getLayerDisplayName(layer)}
                    </Button>
                  }
                >
                  <input
                    ref={(input) => {
                      queueMicrotask(() => {
                        if (editingLayerIdx() !== realIdx) {
                          return;
                        }
                        input.focus();
                        input.select();
                      });
                    }}
                    type="text"
                    value={editingLayerName()}
                    placeholder={getLayerDefaultName(layer.kind)}
                    class="h-6 w-full rounded-sm border border-[var(--border-active)] bg-[var(--input-bg)] px-1.5 text-[13px] font-medium text-[var(--text)] outline-none"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDblClick={(event) => event.stopPropagation()}
                    onInput={(event) => setEditingLayerName(event.currentTarget.value)}
                    onBlur={() => void commitInlineLayerRename()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key !== "Escape") {
                        return;
                      }
                      event.preventDefault();
                      cancelInlineLayerRename();
                    }}
                  />
                </Show>
                <Show when={layer.kind !== "crop"}>
                  {layer.has_mask ? (
                    <Button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRemoveMask(realIdx);
                      }}
                      class="ml-1 border-l border-[var(--border-subtle)] pl-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-value)] transition-colors hover:text-[var(--danger-text)] focus-visible:outline-none"
                      title="Remove mask"
                    >
                      M
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMaskPickerLayer(
                          maskPickerLayer() === realIdx ? null : realIdx,
                        );
                      }}
                      class="ml-1 border-l border-[var(--border-subtle)] pl-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text-dim)] transition-colors hover:text-[var(--text)] focus-visible:outline-none"
                      title="Add gradient mask"
                    >
                      +M
                    </Button>
                  )}
                </Show>
                <Show when={layer.kind !== "image"}>
                  <Button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteLayer(realIdx);
                    }}
                    class="inline-flex h-4 w-4 items-center justify-center text-[var(--text-dim)] transition-colors hover:text-[var(--text)] focus-visible:outline-none"
                    title="Delete layer"
                  >
                    <span innerHTML={trashSvg} />
                  </Button>
                </Show>
              </div>
              <Show when={maskPickerLayer() === realIdx}>
                <div class="ml-6 grid grid-cols-3 gap-2">
                  <Button
                    type="button"
                    onClick={() => void handleApplyLinearMask(realIdx)}
                    class={SECONDARY_BUTTON_CLASS}
                  >
                    Linear
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleApplyRadialMask(realIdx)}
                    class={SECONDARY_BUTTON_CLASS}
                  >
                    Radial
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleApplyBrushMask(realIdx)}
                    class={SECONDARY_BUTTON_CLASS}
                  >
                    Brush
                  </Button>
                </div>
              </Show>
            </>
          );
        })}
      </div>
    </div>
  );

  const DesktopSelectedLayerPanel: Component = () => (
    <Show
      when={state.selectedLayerIdx >= 0}
      fallback={<EmptyState>Open an image and select a layer to edit.</EmptyState>}
    >
      <Show
        when={selectedCropLayer()}
        fallback={
          <Show when={selectedAdjustmentLayer()} fallback={<ImageInfoPanel />}>
            <div class="flex flex-col gap-3 pt-2">
              <ControlSection title="Light">
                <LightSliders />
                <LevelSliders />
                <CurvesEditor />
              </ControlSection>
              <ControlSection title="Color">
                <WhiteBalanceSliders />
                <SaturationSliders />
                <LsCurveEditor />
              </ControlSection>
              <ControlSection title="HSL Color Balance">
                <HslSection />
              </ControlSection>
              <ControlSection title="Effects">
                <GlowSlider />
                <VignetteSlider />
                <SharpenSlider />
                <GrainSliders />
              </ControlSection>
              <ControlSection title="Denoise">
                <DenoiseSliders />
              </ControlSection>
            </div>
          </Show>
        }
      >
        <div class="pt-2">
          <CropPanel />
        </div>
      </Show>
    </Show>
  );

  const MobileSelectedLayerPanel: Component = () => (
    <Show
      when={state.selectedLayerIdx >= 0}
      fallback={<EmptyState>Open an image and select a layer to edit.</EmptyState>}
    >
      <div class="px-1 flex flex-col gap-3">
        <Show
          when={selectedCropLayer()}
          fallback={
            <Show when={selectedAdjustmentLayer()} fallback={<ImageInfoPanel />}>
              <div>
                <MobileLayerBody />
              </div>
            </Show>
          }
        >
          <CropPanel />
        </Show>
      </div>

      <Show when={selectedAdjustmentLayer()}>
        <div
          data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
          class="mobile-slider-fade mt-3 flex flex-col gap-3 border-t border-[var(--border)] pt-3 transition-opacity duration-150"
        >
          <Show when={isPickerOpen()}>
            <div class="flex gap-2 overflow-x-auto">
              {ADD_LAYER_FOCI.map((focus) => (
                <Button
                  type="button"
                  onClick={() => void handleAddLayer(focus)}
                  class="flex min-w-[5.5rem] flex-shrink-0 flex-col items-center gap-1 rounded-lg border border-[var(--border-medium)] bg-[var(--surface)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-active)]"
                >
                  <span class="[&>svg]:h-5 [&>svg]:w-5" innerHTML={focusGlyphs[focus]} />
                  <span>{focusLabels[focus]}</span>
                </Button>
              ))}
            </div>
          </Show>

          <div class="flex items-center gap-1 overflow-x-auto">
            <div class="media-scroll min-w-0 flex-1 overflow-x-auto">
              <div class="flex items-center gap-1">
                {adjustmentLayers().map(({ idx }) => {
                  const focus = () => resolvedLayerFocus(idx);
                  const isActive = () => state.selectedLayerIdx === idx && isDrawerOpen();
                  return (
                    <Button
                      type="button"
                      onClick={() => {
                        selectLayer(idx);
                        setIsDrawerOpen(true);
                        setIsPickerOpen(false);
                      }}
                      class={`${MOBILE_LAYER_TAB_CLASS} ${
                        isActive() ? "text-[var(--text)]" : "text-[var(--text-muted)]"
                      }`}
                    >
                      <span class="[&>svg]:h-5 [&>svg]:w-5" innerHTML={focusGlyphs[focus()]} />
                      <span>{focusLabels[focus()]}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                onClick={() => setIsPickerOpen((v) => !v)}
                class={`${MOBILE_LAYER_TAB_CLASS} min-w-[2.75rem] ${
                  isPickerOpen() ? "text-[var(--text)]" : "text-[var(--text-muted)]"
                }`}
              >
                <span class="flex h-5 w-5 items-center justify-center text-lg leading-none">
                  +
                </span>
                <span>Add</span>
              </Button>

              <Show
                when={
                  state.selectedLayerIdx >= 0 &&
                  state.layers[state.selectedLayerIdx]?.kind !== "image"
                }
              >
                <Button
                  type="button"
                  onClick={() => void handleDeleteSelectedLayer()}
                  class={`${MOBILE_LAYER_TAB_CLASS} min-w-[2.75rem] [&>svg]:h-5 [&>svg]:w-5`}
                >
                  <span innerHTML={trashSvg} />
                  <span>Delete</span>
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </Show>
  );

  return (
    <aside class="lg:w-[340px] lg:flex-none lg:block">
      <div
        class={`m-2 hidden h-[calc(100%-1rem)] lg:flex lg:flex-col ${PANEL_SHELL_CLASS}`}
      >
        <div class="media-scroll flex-1 pr-5 overflow-y-auto">
          <InspectorTabs class="mb-5" />
          <Show when={inspectorTab() === "edit"} fallback={<PresetsPanel />}>
            <div class="flex flex-col gap-5">
              <DesktopLayerList />
              <DesktopSelectedLayerPanel />
            </div>
          </Show>
        </div>
      </div>

      {/* Mobile: drawer overlay */}
      <div
        data-mobile-slider-active={isAdjustmentSliderActive() ? "true" : undefined}
        class={`mobile-slider-drawer fixed bottom-0 left-0 right-0 z-30 border-t border-[var(--border)] bg-[var(--panel-bg)] transition-transform duration-300 ease-out lg:hidden ${
          isDrawerOpen() ? "translate-y-0" : "translate-y-[calc(100%-4.5rem)]"
        }`}
      >
        <div
          data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
          class="mobile-slider-fade flex cursor-pointer flex-col items-center px-4 pt-3 pb-1 transition-opacity duration-150"
          onClick={() => setIsDrawerOpen((v) => !v)}
        >
          <div class="mb-2 h-1.5 w-14 rounded-full bg-[var(--surface-active)]" />
        </div>

        <div class="px-4 pt-3 pb-2">
          <MobileSelectedLayerPanel />
        </div>

        <div
          data-mobile-faded={isAdjustmentSliderActive() ? "true" : undefined}
          class="mobile-slider-fade pb-[env(safe-area-inset-bottom)] transition-opacity duration-150"
        ></div>
      </div>
    </aside>
  );
};
