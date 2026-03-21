import {
  Component,
  JSX,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  addLayer,
  applyEdit,
  applyGradientMask,
  deleteLayer,
  findCropLayerIdx,
  isDrawerOpen,
  listPresets,
  listSnapshots,
  loadPreset,
  loadSnapshot,
  backdropTile,
  moveLayer,
  removeMask,
  savePreset,
  saveSnapshot,
  selectLayer,
  setIsDrawerOpen,
  setLayerVisible,
  state,
} from "../store/editor";
import type { LayerInfo } from "../store/editor";
import { Button } from "./Button";

type MobileLayerFocus =
  | "light"
  | "levels"
  | "color"
  | "wb"
  | "curves"
  | "grain"
  | "vignette"
  | "sharpen"
  | "hsl"
  | "denoise";
type InspectorTab = "edit" | "presets";
type LayerDropTarget = { layerIdx: number; position: "before" | "after" };

interface SliderProps {
  label: string;
  icon: JSX.Element;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  valueLabel?: string;
  onChange: (value: number) => void;
  class?: string;
  accentColor?: string;
}

const Slider: Component<SliderProps> = (props) => {
  let trackRef!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  let pendingPointer:
    | {
        pointerId: number;
        startX: number;
        startY: number;
      }
    | null = null;

  const fraction = () =>
    clamp((props.value - props.min) / (props.max - props.min), 0, 1);
  const defaultFrac = () =>
    clamp((props.defaultValue - props.min) / (props.max - props.min), 0, 1);
  const isBipolar = () => defaultFrac() > 0.01 && defaultFrac() < 0.99;
  const fillLeft = () => Math.min(fraction(), defaultFrac()) * 100;
  const fillWidth = () => Math.abs(fraction() - defaultFrac()) * 100;
  const accent = () => props.accentColor ?? "var(--curve-stroke)";

  const resolve = (clientX: number) => {
    const rect = trackRef.getBoundingClientRect();
    const t = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const raw = props.min + t * (props.max - props.min);
    const step = props.step ?? 0.01;
    return clamp(Math.round(raw / step) * step, props.min, props.max);
  };

  return (
    <div class={props.class ?? ""}>
      <div class="mb-1 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-[13px] font-medium text-[var(--text-strong)]">
          <span class="text-[var(--text-icon)] [&>svg]:h-4 [&>svg]:w-4">{props.icon}</span>
          <span>{props.label}</span>
        </div>
        <span class="text-[11px] font-semibold tracking-[0.03em] text-[var(--text-value)]">
          {props.valueLabel ?? props.value.toFixed(2)}
        </span>
      </div>
      <div
        ref={trackRef!}
        class="relative h-8 cursor-pointer select-none touch-none"
        style={{ "touch-action": "pan-y" }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") {
            e.preventDefault();
            trackRef.setPointerCapture(e.pointerId);
            setDragging(true);
            props.onChange(resolve(e.clientX));
            return;
          }
          pendingPointer = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
          };
        }}
        onPointerMove={(e) => {
          if (!dragging()) {
            if (!pendingPointer || pendingPointer.pointerId !== e.pointerId) {
              return;
            }
            const deltaX = Math.abs(e.clientX - pendingPointer.startX);
            const deltaY = Math.abs(e.clientY - pendingPointer.startY);
            if (deltaX < 8 && deltaY < 8) {
              return;
            }
            if (deltaY > deltaX) {
              pendingPointer = null;
              return;
            }
            e.preventDefault();
            trackRef.setPointerCapture(e.pointerId);
            pendingPointer = null;
            setDragging(true);
            props.onChange(resolve(e.clientX));
            return;
          }
          e.preventDefault();
          props.onChange(resolve(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging() && pendingPointer?.pointerId === e.pointerId) {
            pendingPointer = null;
            props.onChange(resolve(e.clientX));
            return;
          }
          if (trackRef.hasPointerCapture(e.pointerId))
            trackRef.releasePointerCapture(e.pointerId);
          pendingPointer = null;
          setDragging(false);
        }}
        onPointerCancel={(e) => {
          if (trackRef.hasPointerCapture(e.pointerId))
            trackRef.releasePointerCapture(e.pointerId);
          pendingPointer = null;
          setDragging(false);
        }}
        onDblClick={() => props.onChange(props.defaultValue)}
      >
        {/* track */}
        <div class="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--slider-track)]" />
        {/* fill */}
        <div
          class="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
          style={{
            left: `${fillLeft()}%`,
            width: `${fillWidth()}%`,
            background: accent(),
            opacity: 0.65,
            transition: dragging()
              ? "none"
              : "left 140ms ease-out, width 140ms ease-out",
          }}
        />
        {/* default notch */}
        <Show when={isBipolar()}>
          <div
            class="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--slider-notch)]"
            style={{ left: `${defaultFrac() * 100}%` }}
          />
        </Show>
        {/* thumb */}
        <div
          class="absolute top-1/2"
          style={{
            left: `${fraction() * 100}%`,
            transform: `translate(-50%, -50%) scale(${dragging() ? 1.2 : 1})`,
            transition: dragging()
              ? "none"
              : "left 140ms ease-out, transform 100ms ease-out",
          }}
        >
          <div
            class="h-[14px] w-[14px] rounded-full border-2 border-[var(--slider-thumb-border)]"
            style={{
              background: accent(),
              "box-shadow":
                "var(--slider-thumb-shadow)",
            }}
          />
        </div>
      </div>
    </div>
  );
};

const CURVE_SAMPLE_INDICES = [64, 128, 192] as const;
const IDENTITY_LUT = Array.from({ length: 256 }, (_, idx) => idx / 255);
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
  return [...points]
    .map(normalizePoint)
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
}

function buildLutFromPoints(points: readonly ControlPoint[]): number[] {
  const sorted = normalizePoints(points);
  const anchors = [{ x: 0, y: 0 }, ...sorted, { x: 255, y: 1 }];
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

function normalizePoint(point: ControlPoint): ControlPoint {
  return {
    x: clamp(Math.round(point.x), 1, 254),
    y: clamp(point.y, 0, 1),
  };
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

function valueLabel(value: number, scale = 100) {
  return `${Math.round(value * scale)}`;
}

const TONE_THRESHOLD_BOUNDARIES = [
  { key: "shadows", value: 0.25 },
  { key: "midtones", value: 0.5 },
  { key: "highlights", value: 0.75 },
] as const;

const SparkIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
  </svg>
);

const CircleIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <circle cx="12" cy="12" r="7" />
  </svg>
);

const DropletIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="M12 3.5c3.6 4 5.4 6.8 5.4 9a5.4 5.4 0 1 1-10.8 0c0-2.2 1.8-5 5.4-9Z" />
  </svg>
);

const GrainIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="15.5" cy="7.5" r="1.4" />
    <circle cx="11" cy="12.5" r="1.4" />
    <circle cx="7.5" cy="16" r="1.4" />
    <circle cx="16" cy="16.5" r="1.4" />
  </svg>
);

const CurveIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="M4 16c3-6 5.5-8 8-8s4 1.5 8 8" />
  </svg>
);

const ToneIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="M12 4v16" />
    <path d="M4 12h16" />
  </svg>
);

const HslIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <circle cx="9" cy="9" r="4" />
    <circle cx="15" cy="15" r="4" />
  </svg>
);

const CropIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="M8 4v12a2 2 0 0 0 2 2h10" />
    <path d="M4 8h12a2 2 0 0 1 2 2v10" />
  </svg>
);

const TrashIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
  >
    <path d="M4 7h16" />
    <path d="M9 7V5.5c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5V7" />
    <path d="M7.5 7 8.2 18c.1 1.1 1 2 2.1 2h3.4c1.1 0 2-.9 2.1-2L16.5 7" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </svg>
);

const DenoiseIcon = () => (
  <svg
    width="24px"
    height="24px"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 3a9 9 0 1 0 0 18A9 9 0 0 0 12 3z" />
    <path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01M12 12h.01" />
  </svg>
);

const focusGlyphs: Record<MobileLayerFocus, () => JSX.Element> = {
  light: () => <SparkIcon />,
  levels: () => <ToneIcon />,
  color: () => <DropletIcon />,
  wb: () => <ToneIcon />,
  curves: () => <CurveIcon />,
  grain: () => <GrainIcon />,
  vignette: () => <CircleIcon />,
  sharpen: () => <DropletIcon />,
  hsl: () => <HslIcon />,
  denoise: () => <DenoiseIcon />,
};

const focusLabels: Record<MobileLayerFocus, string> = {
  light: "Light",
  levels: "Levels",
  color: "Color",
  wb: "WB",
  curves: "Curves",
  grain: "Grain",
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
  { key: "grain", focus: "grain" },
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

const Inspector: Component = () => {
  const [layerFocusOverrides, setLayerFocusOverrides] = createSignal(
    new Map<number, MobileLayerFocus>(),
  );
  const [curvePointCache, setCurvePointCache] = createSignal(
    new Map<number, ControlPoint[]>(),
  );
  const [isPickerOpen, setIsPickerOpen] = createSignal(false);
  const [maskPickerLayer, setMaskPickerLayer] = createSignal<number | null>(null);
  const [hslTab, setHslTab] = createSignal<"red" | "green" | "blue">("red");
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>("edit");
  const [presets, setPresets] = createSignal<{ name: string }[]>([]);
  const [snapshots, setSnapshots] = createSignal<
    { version: number; created_at: number; is_current: boolean }[]
  >([]);
  const [presetName, setPresetName] = createSignal("");
  const [presetStatus, setPresetStatus] = createSignal<string | null>(null);
  const [isPresetBusy, setIsPresetBusy] = createSignal(false);
  const [draggedLayerIdx, setDraggedLayerIdx] = createSignal<number | null>(null);
  const [dropTarget, setDropTarget] = createSignal<LayerDropTarget | null>(null);
  let desktopLayerListRef: HTMLDivElement | undefined;

  const selectedLayer = () => state.layers[state.selectedLayerIdx];
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
    CURVE_SAMPLE_INDICES.map((x) => ({ x, y: IDENTITY_LUT[x] }));

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
            (points.length === 0 ? defaultCurvePoints() : points).map((point) => ({
              ...point,
              id: nextId++,
            })),
          );
          setDraggingId(null);
          setHoveredId(null);
        },
      ),
    );

    const lut = () => buildLutFromPoints(pts());
    const graphPadding = 10;
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
      const { x, y } = normalizePoint(svgCoords({ clientX, clientY }));
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
      const { x, y } = normalizePoint(svgCoords({ clientX, clientY }));
      const id = nextId++;
      const next = [...pts(), { x, y, id }].sort((a, b) => a.x - b.x);
      setPts(next);
      selectedAdjustmentLayerOrThrow();
      void applyCurves(next);
      setDraggingId(id);
    };

    const startExistingPointDrag = (id: number) => {
      setHoveredId(id);
      const now = Date.now();
      if (now - lastTapTime < 300 && lastTapId === id) {
        lastTapTime = 0;
        const next = pts().filter((p) => p.id !== id);
        setPts(next);
        selectedAdjustmentLayerOrThrow();
        void applyCurves(next);
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
      <div class="py-1">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-2 text-[13px] font-medium text-[var(--text-strong)]">
            <span class="text-[var(--text-icon)] [&>svg]:h-4 [&>svg]:w-4">
              <CurveIcon />
            </span>
            <span>Curves</span>
          </div>
          <span class="text-[11px] font-semibold tracking-[0.03em] text-[var(--text-value)]">
            Master
          </span>
        </div>
        <div class="lg:-mx-4">
          <svg
            ref={svgRef!}
            viewBox={`0 0 ${svgSize().width} ${svgSize().height}`}
            class="block h-40 w-full select-none"
            style={{
              cursor: draggingId() !== null ? "grabbing" : "crosshair",
              "touch-action": "none",
            }}
            onPointerDown={(e) => {
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
                stroke={boundary.value === 0.5 ? "var(--curve-guide-mid)" : "var(--curve-guide)"}
                stroke-width={boundary.value === 0.5 ? "0.9" : "0.7"}
                stroke-dasharray={boundary.value === 0.5 ? "4 4" : "2 6"}
                opacity={boundary.value === 0.5 ? "0.4" : "0.28"}
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
                      throw new Error("curve point touch interaction requires an active touch point");
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
            {TONE_THRESHOLD_BOUNDARIES.map((boundary) => (
              <text
                x={chartThresholdX(boundary.value)}
                y={svgSize().height - 2}
                fill="var(--curve-label)"
                font-size="9"
                text-anchor={
                  boundary.value === 0 ? "start" : boundary.value === 1 ? "end" : "middle"
                }
                pointer-events="none"
              >
                {boundary.label}
              </text>
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
        <div class="flex gap-1">
          {(["red", "green", "blue"] as const).map((c) => (
            <Button
              type="button"
              onClick={() => setHslTab(c)}
              class={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${
                hslTab() === c
                  ? HSL_TAB_STYLES[c].tabClass
                  : "text-[var(--text-dim)] hover:text-[var(--text-faint)]"
              }`}
            >
              {c}
            </Button>
          ))}
        </div>
        <Slider
          label="Hue"
          icon={<HslIcon />}
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
          icon={<DropletIcon />}
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
          icon={<ToneIcon />}
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

  const LightSliders: Component = () => (
    <>
      <Slider
        label="Exposure"
        icon={<SparkIcon />}
        value={tone().exposure}
        defaultValue={DEFAULT_TONE.exposure}
        min={-5}
        max={5}
        step={0.05}
        onChange={(v) => applyTone({ exposure: v })}
      />
      <Slider
        label="Gamma"
        icon={<ToneIcon />}
        value={tone().gamma}
        defaultValue={DEFAULT_TONE.gamma}
        min={0.1}
        max={3}
        onChange={(v) => applyTone({ gamma: v })}
      />
      <Slider
        label="Contrast"
        icon={<CircleIcon />}
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
        icon={<ToneIcon />}
        value={tone().blacks}
        defaultValue={DEFAULT_TONE.blacks}
        min={-0.05}
        max={0.1}
        step={0.001}
        onChange={(v) => applyTone({ blacks: v })}
      />
      <Slider
        label="Whites"
        icon={<ToneIcon />}
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
        icon={<DropletIcon />}
        value={color().saturation}
        defaultValue={DEFAULT_COLOR.saturation}
        valueLabel={valueLabel(color().saturation)}
        min={0}
        max={2}
        onChange={(v) => applyColor({ saturation: v })}
      />
      <Slider
        label="Vibrancy"
        icon={<DropletIcon />}
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
        icon={<ToneIcon />}
        value={color().temperature}
        defaultValue={DEFAULT_COLOR.temperature}
        valueLabel={valueLabel(color().temperature)}
        min={-1}
        max={1}
        onChange={(v) => applyColor({ temperature: v })}
      />
      <Slider
        label="Tint"
        icon={<ToneIcon />}
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
        icon={<GrainIcon />}
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
        icon={<GrainIcon />}
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
      icon={<CircleIcon />}
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

  const SharpenSlider: Component = () => (
    <Slider
      label="Sharpen"
      icon={<DropletIcon />}
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
        icon={<DenoiseIcon />}
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
        icon={<DenoiseIcon />}
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

  const selectedFocus = (): MobileLayerFocus =>
    layerFocusOverrides().get(state.selectedLayerIdx) ??
    inferFocus(state.layers[state.selectedLayerIdx]);

  const displayedCrop = () =>
    selectedCropLayer()?.crop ?? {
      x: 0,
      y: 0,
      width: state.canvasWidth,
      height: state.canvasHeight,
      rotation: 0,
    };
  const setCropField = (field: "x" | "y" | "width" | "height" | "rotation", value: number) => {
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
    if (focus === "curves") {
      await addLayer("curves");
    } else {
      await addLayer("adjustment");
    }
    const newIdx = state.selectedLayerIdx;
    setLayerFocusOverrides((prev) => new Map(prev).set(newIdx, focus));
    setIsDrawerOpen(true);
  };

  const handleApplyLinearMask = async (idx: number) => {
    const w = state.canvasWidth;
    const h = state.canvasHeight;
    await applyGradientMask({ kind: "linear", layer_idx: idx, x1: 0, y1: 0, x2: 0, y2: h });
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

  const refreshPresetList = async () => {
    try {
      setPresets(await listPresets());
      setSnapshots(await listSnapshots());
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const formatSnapshotDate = (createdAt: number) => new Date(createdAt).toLocaleString();

  createEffect(() => {
    if (inspectorTab() !== "presets") return;
    void refreshPresetList();
  });

  const handleSavePreset = async () => {
    const name = presetName().trim();
    if (!name) {
      setPresetStatus("Preset name cannot be empty");
      return;
    }
    setIsPresetBusy(true);
    try {
      await savePreset(name);
      setPresetStatus(`Saved ${name}`);
      await refreshPresetList();
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

  const handleLoadSnapshot = async (version: number) => {
    setIsPresetBusy(true);
    try {
      await loadSnapshot(version);
      setPresetStatus(`Loaded snapshot ${version}`);
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
      const snapshot = await saveSnapshot();
      setPresetStatus(`Saved snapshot ${snapshot.version}`);
      await refreshPresetList();
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };

  const renderLayerBody = () => {
    switch (selectedFocus()) {
      case "light":
        return <LightSliders />;
      case "levels":
        return <LevelSliders />;
      case "color":
        return <SaturationSliders />;
      case "wb":
        return <WhiteBalanceSliders />;
      case "curves":
        return <CurvesEditor />;
      case "grain":
        return <GrainSliders />;
      case "vignette":
        return <VignetteSlider />;
      case "sharpen":
        return <SharpenSlider />;
      case "hsl":
        return <HslSection />;
      case "denoise":
        return <DenoiseSliders />;
    }
  };

  const CropPanel: Component = () => {
    const crop = () => displayedCrop();
    const hasCropLayer = () => findCropLayerIdx() >= 0;

    return (
      <div class="mb-5 border border-[var(--border-soft)] bg-[var(--surface-faint)] p-3">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-[13px] font-medium text-[var(--text-strong)]">
            <span class="text-[var(--text-icon)] [&>svg]:h-4 [&>svg]:w-4">
              <CropIcon />
            </span>
            <span>Crop</span>
          </div>
          <span class="text-[11px] font-semibold tracking-[0.03em] text-[var(--text-icon)]">
            {crop().width} × {crop().height}
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          {(["x", "y", "width", "height"] as const).map((field) => (
            <label class="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
              <span>{field}</span>
              <input
                type="number"
                value={crop()[field]}
                disabled={!selectedCropLayer()}
                min="0"
                step="1"
                onInput={(event) =>
                  setCropField(field, event.currentTarget.valueAsNumber)
                }
                class="min-h-10 border border-[var(--border-soft)] bg-[var(--input-bg)] px-3 text-[13px] font-medium text-[var(--text)] outline-none transition-colors disabled:opacity-45"
              />
            </label>
          ))}
          <label class="col-span-2 flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
            <span>Rotation</span>
            <input
              type="number"
              value={Math.round(crop().rotation * 180 / Math.PI * 10) / 10}
              disabled={!selectedCropLayer()}
              step="0.5"
              onInput={(event) =>
                setCropField("rotation", event.currentTarget.valueAsNumber * Math.PI / 180)
              }
              class="min-h-10 border border-[var(--border-soft)] bg-[var(--input-bg)] px-3 text-[13px] font-medium text-[var(--text)] outline-none transition-colors disabled:opacity-45"
            />
          </label>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
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
                  void addLayer("crop");
                }}
                class="min-h-10 border border-[var(--border-soft)] bg-[var(--surface)] px-3 text-[12px] font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                {hasCropLayer() ? "Select crop" : "Add crop layer"}
              </Button>
            }
          >
            <Button
              type="button"
              onClick={() => setCropField("x", 0)}
              class="min-h-10 border border-[var(--border-soft)] bg-[var(--surface)] px-3 text-[12px] font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
              class="min-h-10 border border-[var(--border-soft)] bg-[var(--surface)] px-3 text-[12px] font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              Reset
            </Button>
          </Show>
        </div>
      </div>
    );
  };

  const PresetsPanel: Component = () => (
    <div class="flex flex-col gap-4 pt-1">
      <div class="flex items-center justify-between gap-3">
        <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
          Presets
        </div>
        <Button
          type="button"
          onClick={() => void refreshPresetList()}
          class="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text-faint)] transition-colors hover:text-[var(--text-muted)]"
        >
          Refresh
        </Button>
      </div>
      <div class="flex gap-2">
        <input
          type="text"
          value={presetName()}
          onInput={(event) => setPresetName(event.currentTarget.value)}
          placeholder="Preset name"
          class="min-h-10 flex-1 border border-[var(--border-soft)] bg-[var(--input-bg)] px-3 text-[13px] font-medium text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-dim)]"
        />
        <Button
          type="button"
          disabled={isPresetBusy() || state.canvasWidth <= 0}
          onClick={() => void handleSavePreset()}
          class="min-h-10 rounded-xl border border-[var(--border-medium)] bg-[var(--surface)] px-3 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
        >
          Save
        </Button>
      </div>
      <Show when={presetStatus()}>
        {(status) => <div class="text-[11px] font-medium text-[var(--text-icon)]">{status()}</div>}
      </Show>
      <div class="flex flex-col gap-2">
        <Show
          when={presets().length > 0}
          fallback={
            <div class="border border-dashed border-[var(--border-medium)] bg-[var(--surface-subtle)] px-3 py-4 text-sm text-[var(--text-faint)]">
              No presets saved yet.
            </div>
          }
        >
          {presets().map((preset) => (
            <div class="flex items-center gap-2 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-faint)] px-3 py-2.5">
              <div class="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-secondary)]">
                {preset.name}
              </div>
              <Button
                type="button"
                disabled={isPresetBusy() || state.canvasWidth <= 0}
                onClick={() => void handleLoadPreset(preset.name)}
                class="rounded-lg border border-[var(--border-medium)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
              >
                Load
              </Button>
            </div>
          ))}
        </Show>
      </div>
      <div class="flex flex-col gap-2 pt-2">
        <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
          Image Snapshots
        </div>
        <Show
          when={snapshots().length > 0}
          fallback={
            <div class="border border-dashed border-[var(--border-medium)] bg-[var(--surface-subtle)] px-3 py-4 text-sm text-[var(--text-faint)]">
              No snapshots yet.
            </div>
          }
        >
          {snapshots().map((snapshot) => (
            <div class="flex items-center gap-3 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-faint)] px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13px] font-semibold text-[var(--text-secondary)]">
                  {`Version ${snapshot.version}`}
                </div>
                <div class="text-[11px] text-[var(--text-faint)]">
                  {formatSnapshotDate(snapshot.created_at)}
                </div>
              </div>
              <Show when={snapshot.is_current}>
                <div class="rounded-lg border border-[var(--border-medium)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)]">
                  Current
                </div>
              </Show>
              <Button
                type="button"
                disabled={isPresetBusy() || state.canvasWidth <= 0 || snapshot.is_current}
                onClick={() => void handleLoadSnapshot(snapshot.version)}
                class="rounded-lg border border-[var(--border-medium)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
              >
                Load
              </Button>
            </div>
          ))}
        </Show>
        <Button
          type="button"
          disabled={isPresetBusy() || state.canvasWidth <= 0}
          onClick={() => void handleSaveSnapshot()}
          class="mt-1 rounded-xl border border-[var(--border-medium)] bg-[var(--surface)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
        >
          Save Snapshot
        </Button>
      </div>
    </div>
  );

  const InspectorTabs: Component<{ class?: string }> = (props) => (
    <div class={props.class ?? ""}>
      <div class="flex gap-1 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-faint)] p-1">
        {(["edit", "presets"] as const).map((tab) => (
          <Button
            type="button"
            onClick={() => setInspectorTab(tab)}
            class={`flex-1 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors ${
              inspectorTab() === tab
                ? "bg-[var(--surface-selected)] text-[var(--text)]"
                : "text-[var(--text-faint)] hover:text-[var(--text-muted)]"
            }`}
          >
            {tab}
          </Button>
        ))}
      </div>
    </div>
  );

  const DesktopEditPanel: Component = () => (
    <div>
      <div class="mb-4">
        <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
          Layers
        </div>
        <div
          ref={desktopLayerListRef}
          class="relative mt-3 flex flex-col gap-[2px]"
        >
          <div
            class="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 -translate-y-1/2 rounded-full bg-blue-400 transition-opacity"
            style={getDesktopDropCursorStyle()}
          />
          {[...state.layers].reverse().map((layer, reverseIdx) => {
            const realIdx = state.layers.length - 1 - reverseIdx;
            const layerName =
              layer.kind === "image"
                ? "Image"
                : layer.kind === "crop"
                  ? "Crop"
                  : "Adjustment";
            return (
              <>
                <div
                  data-layer-idx={realIdx}
                  class={`flex min-h-9 w-full items-center gap-2 border px-2.5 text-left text-[var(--text-secondary)] transition-colors ${
                    state.selectedLayerIdx === realIdx
                      ? "border-[var(--border-dashed)] bg-[var(--surface-active)] text-[var(--text)]"
                      : "border-[var(--border-subtle)] bg-[var(--surface-faint)] hover:border-[var(--border-medium)] hover:bg-[var(--surface-hover)]"
                  } ${draggedLayerIdx() === realIdx ? "opacity-45" : ""}`}
                >
                  <Button
                    type="button"
                    onPointerDown={(event) => startDesktopLayerDrag(event, realIdx)}
                    class="inline-flex h-5 w-5 cursor-grab items-center justify-center text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)] active:cursor-grabbing"
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
                  <span
                    class={`inline-flex w-4 items-center justify-center text-xs leading-none ${
                      layer.visible ? "text-[var(--text)]" : "text-[var(--text-subtle)]"
                    }`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void setLayerVisible(realIdx, !layer.visible);
                    }}
                  >
                    {layer.visible ? "●" : "○"}
                  </span>
                  <Button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => selectLayer(realIdx)}
                    class="min-w-0 flex-1 truncate text-left text-[13px] font-semibold tracking-[-0.01em] py-1.5"
                  >
                    {layerName}
                  </Button>
                  <Show when={layer.kind !== "crop"}>
                    {layer.has_mask ? (
                      <Button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRemoveMask(realIdx);
                        }}
                        class="text-[10px] font-bold text-blue-400 transition-colors hover:text-[var(--danger-text)]"
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
                          setMaskPickerLayer(maskPickerLayer() === realIdx ? null : realIdx);
                        }}
                        class="text-[10px] font-bold text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
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
                      class="inline-flex h-5 w-5 items-center justify-center text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
                      title="Delete layer"
                    >
                      <TrashIcon />
                    </Button>
                  </Show>
                </div>
                <Show when={maskPickerLayer() === realIdx}>
                  <div class="flex gap-1 border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5">
                    <Button
                      type="button"
                      onClick={() => void handleApplyLinearMask(realIdx)}
                      class="flex-1 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] py-1 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    >
                      Linear
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void handleApplyRadialMask(realIdx)}
                      class="flex-1 rounded-md border border-[var(--border-medium)] bg-[var(--surface)] py-1 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    >
                      Radial
                    </Button>
                  </div>
                </Show>
              </>
            );
          })}
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            onClick={() => void addLayer("adjustment")}
            class="flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--border-medium)] bg-[var(--surface-faint)] px-2 py-2 text-[9px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <span class="[&>svg]:h-4 [&>svg]:w-4">
              <SparkIcon />
            </span>
            <span>Add Adjustments</span>
          </Button>
          <Button
            type="button"
            onClick={() => void addLayer("crop")}
            class="flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--border-medium)] bg-[var(--surface-faint)] px-2 py-2 text-[9px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] transition-colors hover:border-[var(--border-active)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          >
            <span class="[&>svg]:h-4 [&>svg]:w-4">
              <CropIcon />
            </span>
            <span>Add Crop</span>
          </Button>
        </div>
      </div>
      <InspectorTabs class="mb-4" />
    </div>
  );

  return (
    <aside class="lg:w-[340px] lg:flex-none lg:block">
      <div class="hidden h-full border border-[var(--border)] bg-[var(--panel-bg)] lg:flex lg:flex-col m-2 rounded-md">
        <div class="flex-1 overflow-y-auto px-4 py-2">
          <DesktopEditPanel />
          {inspectorTab() === "presets" ? (
            <PresetsPanel />
          ) : (
            <Show
              when={selectedCropLayer()}
              fallback={
                <Show
                  when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
                  fallback={
                    <div class="border border-dashed border-[var(--border-dashed)] bg-[var(--surface-faint)] px-4 py-4 text-center text-sm text-[var(--text-icon)]">
                      Open an image and select a layer to edit.
                    </div>
                  }
                >
                  <div class="flex flex-col gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
                      Adjustments
                    </div>
                    <LightSliders />
                    <LevelSliders />
                    <SaturationSliders />
                    <WhiteBalanceSliders />
                    <CurvesEditor />
                    <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
                      HSL Color Balance
                    </div>
                    <HslSection />
                    <VignetteSlider />
                    <SharpenSlider />
                    <GrainSliders />
                    <DenoiseSliders />
                  </div>
                </Show>
              }
            >
              <CropPanel />
            </Show>
          )}
        </div>
      </div>

      {/* Mobile: drawer overlay */}
      <div
        class={`fixed bottom-0 left-0 right-0 z-30  bg-[var(--input-bg)] transition-transform duration-300 ease-out lg:hidden ${
          isDrawerOpen() ? "translate-y-0" : "translate-y-[calc(100%-4.5rem)]"
        }`}
      >
        <div
          class="flex cursor-pointer flex-col items-center px-4 pt-3 pb-1"
          onClick={() => setIsDrawerOpen((v) => !v)}
        >
          <div class="mb-2 h-1.5 w-14 rounded-full bg-[var(--surface-active)]" />
        </div>

        <div class="px-4 pb-2">
          <Show
            when={inspectorTab() === "presets"}
            fallback={
              <Show
                when={selectedCropLayer()}
                fallback={
                  <Show
                    when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
                    fallback={
                      <div class="px-1 text-center text-sm text-[var(--text-icon)]">
                        Open an image and select a layer to edit.
                      </div>
                    }
                  >
                    <div class="px-1">{renderLayerBody()}</div>
                    
                    {/* Layer tabs + add button */}
                    <div class="flex items-center gap-1 overflow-x-auto border-t border-[var(--border)] py-3">
                      {adjustmentLayers().map(({ idx }) => {
                        const focus = () =>
                          layerFocusOverrides().get(idx) ??
                          inferFocus(state.layers[idx]);
                        const isActive = () => state.selectedLayerIdx === idx && isDrawerOpen();
                        return (
                          <Button
                            type="button"
                            onClick={() => {
                              selectLayer(idx);
                              setIsDrawerOpen(true);
                              setIsPickerOpen(false);
                            }}
                            class={`flex min-w-[3.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
                              isActive() ? "text-[var(--text)]" : "text-[var(--text-faint)]"
                            }`}
                          >
                            <span class="[&>svg]:h-5 [&>svg]:w-5">{focusGlyphs[focus()]()}</span>
                            <span>{focusLabels[focus()]}</span>
                          </Button>
                        );
                      })}
            
                      <div class="flex-1"></div>
            
                      <Button
                        type="button"
                        onClick={() => setIsPickerOpen((v) => !v)}
                        class={`ml-1 flex min-w-[2.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
                          isPickerOpen() ? "text-[var(--text)]" : "text-[var(--text-faint)]"
                        }`}
                      >
                        <span class="flex h-[24px] w-[24px] items-center justify-center text-lg leading-none">
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
                          class="ml-1 flex min-w-[2.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em]"
                        >
                          <TrashIcon />
                          <span>Delete</span>
                        </Button>
                      </Show>
                    </div>
                  </Show>
                }
              >
                <div class="px-1">
                  <CropPanel />
                </div>
              </Show>
            }
          >
            <div class="px-1">
              <PresetsPanel />
            </div>
          </Show>
        </div>

        <div class="border-t border-[var(--border)] px-4 pt-3">
          <InspectorTabs />
        </div>

        <div class="pb-[env(safe-area-inset-bottom)]"></div>
      </div>

      {/* Add layer dialog */}
      <Show when={isPickerOpen()}>
        <div
          class="fixed bottom-35 right-0 z-50 flex items-center justify-center lg:hidden"
          onClick={() => setIsPickerOpen(false)}
        >
          <div
            class="mx-6 w-full max-w-xs rounded-2xl border border-[var(--border-medium)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="mb-4 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
              Add adjustment layer
            </div>
            <div class="grid grid-rows-6 gap-2">
              {(["light", "levels", "color", "wb", "curves", "grain", "vignette", "sharpen", "hsl", "denoise"] as const).map(
                (focus) => (
                  <Button
                    type="button"
                    onClick={() => void handleAddLayer(focus)}
                    class="flex items-center gap-1.5 rounded-xl border border-[var(--border-medium)] px-3 py-3 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] data-[pressed=true]:bg-[var(--surface-selected)]"
                  >
                    <span class="[&>svg]:h-5 [&>svg]:w-5">{focusGlyphs[focus]()}</span>
                    <span>{focusLabels[focus]}</span>
                  </Button>
                ),
              )}

              <Button
                type="button"
                onClick={() => void setIsPickerOpen(false)}
                class="flex justify-end items-center gap-1.5 rounded-xl px-3 py-3 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--text-muted)] data-[pressed=true]:bg-[var(--surface-selected)]"
              >
                <span>Cancel</span>
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
};

export default Inspector;
