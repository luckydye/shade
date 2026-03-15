import { Component, JSX, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  addLayer,
  applyEdit,
  deleteLayer,
  findCropLayerIdx,
  isDrawerOpen,
  listPresets,
  loadPreset,
  previewContextFrame,
  savePreset,
  selectLayer,
  setIsDrawerOpen,
  setLayerVisible,
  state,
} from "../store/editor";

type MobileLayerFocus = "tone" | "curves" | "grain" | "vignette" | "sharpen" | "hsl";
type InspectorTab = "edit" | "presets";

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

const Slider: Component<SliderProps> = (props) => (
  <div class={props.class ?? ""}>
    <div class="mb-1 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-[13px] font-medium text-white/82">
        <span class="text-white/42 [&>svg]:h-4 [&>svg]:w-4">{props.icon}</span>
        <span>{props.label}</span>
      </div>
      <span class="text-[11px] font-semibold tracking-[0.03em] text-white/62">
        {props.valueLabel ?? props.value.toFixed(2)}
      </span>
    </div>
    <input
      type="range"
      min={props.min}
      max={props.max}
      step={props.step ?? 0.01}
      value={props.value}
      onInput={(e) => props.onChange(parseFloat(e.currentTarget.value))}
      onDblClick={() => props.onChange(props.defaultValue)}
      class="slider h-2 w-full cursor-pointer appearance-none rounded-full"
      style={{
        "accent-color": props.accentColor ?? "#ffffff",
        "--slider-accent": props.accentColor ?? "#ffffff",
      }}
    />
  </div>
);

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
  temperature: 0,
  tint: 0,
} as const;
const DEFAULT_VIGNETTE = { amount: 0 } as const;
const DEFAULT_SHARPEN = { amount: 0 } as const;
const DEFAULT_GRAIN = { amount: 0 } as const;
const DEFAULT_CURVES = {
  lut_r: IDENTITY_LUT,
  lut_g: IDENTITY_LUT,
  lut_b: IDENTITY_LUT,
  lut_master: IDENTITY_LUT,
  per_channel: false,
} as const;
const DEFAULT_HSL = {
  red_hue: 0, red_sat: 0, red_lum: 0,
  green_hue: 0, green_sat: 0, green_lum: 0,
  blue_hue: 0, blue_sat: 0, blue_lum: 0,
} as const;
const HSL_TAB_STYLES = {
  red: { tabClass: "text-red-400 bg-red-500/15", accentColor: "#f87171" },
  green: { tabClass: "text-green-400 bg-green-500/15", accentColor: "#4ade80" },
  blue: { tabClass: "text-blue-400 bg-blue-500/15", accentColor: "#60a5fa" },
} as const;

interface ControlPoint { x: number; y: number; }

interface EditableControlPoint extends ControlPoint { id: number; }

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
        h00 * start.y + h10 * span * tangent[seg] + h01 * end.y + h11 * span * tangent[seg + 1],
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
    const luminance = (
      (data[idx] / 255) * 0.2126
      + (data[idx + 1] / 255) * 0.7152
      + (data[idx + 2] / 255) * 0.0722
    ) * alpha;
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

const SparkIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
  </svg>
);

const CircleIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="12" cy="12" r="7" />
  </svg>
);

const DropletIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M12 3.5c3.6 4 5.4 6.8 5.4 9a5.4 5.4 0 1 1-10.8 0c0-2.2 1.8-5 5.4-9Z" />
  </svg>
);

const GrainIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="15.5" cy="7.5" r="1.4" />
    <circle cx="11" cy="12.5" r="1.4" />
    <circle cx="7.5" cy="16" r="1.4" />
    <circle cx="16" cy="16.5" r="1.4" />
  </svg>
);

const CurveIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M4 16c3-6 5.5-8 8-8s4 1.5 8 8" />
  </svg>
);

const ToneIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M12 4v16" />
    <path d="M4 12h16" />
  </svg>
);

const HslIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="9" cy="9" r="4" />
    <circle cx="15" cy="15" r="4" />
  </svg>
);

const CropIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M8 4v12a2 2 0 0 0 2 2h10" />
    <path d="M4 8h12a2 2 0 0 1 2 2v10" />
  </svg>
);

const TrashIcon = () => (
  <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M4 7h16" />
    <path d="M9 7V5.5c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5V7" />
    <path d="M7.5 7 8.2 18c.1 1.1 1 2 2.1 2h3.4c1.1 0 2-.9 2.1-2L16.5 7" />
    <path d="M10 11v5" />
    <path d="M14 11v5" />
  </svg>
);

const focusGlyphs: Record<MobileLayerFocus, () => JSX.Element> = {
  tone: () => <SparkIcon />,
  curves: () => <CurveIcon />,
  grain: () => <GrainIcon />,
  vignette: () => <CircleIcon />,
  sharpen: () => <DropletIcon />,
  hsl: () => <HslIcon />,
};

const focusLabels: Record<MobileLayerFocus, string> = {
  tone: "Tone",
  curves: "Curves",
  grain: "Grain",
  vignette: "Vignette",
  sharpen: "Sharpen",
  hsl: "HSL",
};

const Inspector: Component = () => {
  const [layerFocusTypes, setLayerFocusTypes] = createSignal(new Map<number, MobileLayerFocus>());
  const [curvePointCache, setCurvePointCache] = createSignal(new Map<number, ControlPoint[]>());
  const [isPickerOpen, setIsPickerOpen] = createSignal(false);
  const [hslTab, setHslTab] = createSignal<"red" | "green" | "blue">("red");
  const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>("edit");
  const [presets, setPresets] = createSignal<{ name: string }[]>([]);
  const [presetName, setPresetName] = createSignal("");
  const [presetStatus, setPresetStatus] = createSignal<string | null>(null);
  const [isPresetBusy, setIsPresetBusy] = createSignal(false);

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
  const defaultCurvePoints = () => CURVE_SAMPLE_INDICES.map((x) => ({ x, y: IDENTITY_LUT[x] }));

  const tone = () => selectedAdjustmentLayer()?.adjustments?.tone ?? {
    ...DEFAULT_TONE,
  };
  const curves = () => selectedAdjustmentLayer()?.adjustments?.curves ?? DEFAULT_CURVES;
  const color = () => selectedAdjustmentLayer()?.adjustments?.color ?? DEFAULT_COLOR;
  const vignette = () => selectedAdjustmentLayer()?.adjustments?.vignette ?? DEFAULT_VIGNETTE;
  const sharpen = () => selectedAdjustmentLayer()?.adjustments?.sharpen ?? DEFAULT_SHARPEN;
  const grain = () => selectedAdjustmentLayer()?.adjustments?.grain ?? DEFAULT_GRAIN;
  const hsl = () => selectedAdjustmentLayer()?.adjustments?.hsl ?? DEFAULT_HSL;

  const applyCurves = (points: readonly ControlPoint[]) => {
    const normalizedPoints = normalizePoints(points);
    setCurvePointCache((prev) => new Map(prev).set(state.selectedLayerIdx, normalizedPoints));
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
      red_hue:   next.red_hue   ?? current.red_hue,
      red_sat:   next.red_sat   ?? current.red_sat,
      red_lum:   next.red_lum   ?? current.red_lum,
      green_hue: next.green_hue ?? current.green_hue,
      green_sat: next.green_sat ?? current.green_sat,
      green_lum: next.green_lum ?? current.green_lum,
      blue_hue:  next.blue_hue  ?? current.blue_hue,
      blue_sat:  next.blue_sat  ?? current.blue_sat,
      blue_lum:  next.blue_lum  ?? current.blue_lum,
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
      const frame = previewContextFrame();
      return frame ? buildLuminanceHistogram(frame) : [];
    });
    let svgRef!: SVGSVGElement;
    let nextId = 0;
    let lastTapTime = 0;
    let lastTapId = -1;

    createEffect(on(() => state.selectedLayerIdx, (layerIdx) => {
      const layer = state.layers[layerIdx];
      if (layer?.kind !== "adjustment") {
        setPts([]);
        setDraggingId(null);
        setHoveredId(null);
        return;
      }
      const points = curvePointCache().get(layerIdx)
        ?? layer.adjustments?.curves?.control_points
        ?? defaultCurvePoints();
      nextId = 0;
      setPts((points.length === 0 ? defaultCurvePoints() : points).map((point) => ({ ...point, id: nextId++ })));
      setDraggingId(null);
      setHoveredId(null);
    }));

    const lut = () => buildLutFromPoints(pts());
    const graphPadding = 10;
    const innerWidth = () => Math.max(1, svgSize().width - graphPadding * 2);
    const innerHeight = () => Math.max(1, svgSize().height - graphPadding * 2);
    const chartX = (value: number) => graphPadding + (value / 255) * innerWidth();
    const chartY = (value: number) => graphPadding + (1 - value) * innerHeight();
    const curveSvgPath = () => remapPath(curvePath(lut()), svgSize().width, svgSize().height, graphPadding);
    const histogramSvgPath = () => remapPath(histogramPath(luminanceHistogram()), svgSize().width, svgSize().height, graphPadding);

    onMount(() => {
      const updateSize = () => {
        const width = Math.max(1, Math.round(svgRef.clientWidth));
        const height = Math.max(1, Math.round(svgRef.clientHeight));
        setSvgSize({ width, height });
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(svgRef);
      onCleanup(() => observer.disconnect());
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

    return (
      <div class="py-1">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-2 text-[13px] font-medium text-white/82">
            <span class="text-white/42 [&>svg]:h-4 [&>svg]:w-4"><CurveIcon /></span>
            <span>Curves</span>
          </div>
          <span class="text-[11px] font-semibold tracking-[0.03em] text-white/62">Master</span>
        </div>
        <div class="lg:-mx-4">
          <svg
            ref={svgRef!}
            viewBox={`0 0 ${svgSize().width} ${svgSize().height}`}
            class="block h-40 w-full select-none"
            style={{ cursor: draggingId() !== null ? "grabbing" : "crosshair" }}
            onPointerDown={(e) => {
              if (e.target !== svgRef) return;
              const { x, y } = normalizePoint(svgCoords(e));
              const id = nextId++;
              const next = [...pts(), { x, y, id }].sort((a, b) => a.x - b.x);
              setPts(next);
              selectedAdjustmentLayerOrThrow();
              void applyCurves(next);
              svgRef.setPointerCapture(e.pointerId);
              setDraggingId(id);
            }}
            onPointerMove={(e) => {
              const id = draggingId();
              if (id === null) return;
              const { x, y } = normalizePoint(svgCoords(e));
              const next = pts().map(p => p.id === id ? { ...p, x, y } : p).sort((a, b) => a.x - b.x);
              setPts(next);
              selectedAdjustmentLayerOrThrow();
              void applyCurves(next);
            }}
            onPointerUp={(e) => {
              if (svgRef.hasPointerCapture(e.pointerId)) svgRef.releasePointerCapture(e.pointerId);
              setDraggingId(null);
            }}
            onPointerLeave={() => {
              setDraggingId(null);
              setHoveredId(null);
            }}
          >
            <rect x={graphPadding} y={graphPadding} width={innerWidth()} height={innerHeight()} fill="#080808" pointer-events="none" />
            <Show when={histogramSvgPath()}>
              {(path) => <path d={path()} fill="#f5f5f4" fill-opacity="0.12" stroke="none" pointer-events="none" />}
            </Show>
            <path d={`M ${graphPadding} ${graphPadding + innerHeight()} L ${graphPadding + innerWidth()} ${graphPadding}`} stroke="#525252" stroke-width="0.8" fill="none" pointer-events="none" />
            <path d={curveSvgPath()} stroke="#f5f5f4" stroke-width="1.5" fill="none" pointer-events="none" />
            {pts().map((pt) => (
              <>
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="7"
                  fill="none"
                  stroke="#f5f5f4"
                  stroke-width="1.5"
                  opacity={hoveredId() === pt.id ? "0.75" : "0"}
                  pointer-events="none"
                />
                <circle
                  cx={chartX(pt.x)}
                  cy={chartY(pt.y)}
                  r="4.5"
                  fill="#f5f5f4"
                  stroke="#111111"
                  stroke-width="1.5"
                  style={{ cursor: draggingId() === pt.id ? "grabbing" : "grab" }}
                  onPointerEnter={() => setHoveredId(pt.id)}
                  onPointerLeave={() => setHoveredId((current) => current === pt.id ? null : current)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setHoveredId(pt.id);
                    const now = Date.now();
                    if (now - lastTapTime < 300 && lastTapId === pt.id) {
                      lastTapTime = 0;
                      const next = pts().filter(p => p.id !== pt.id);
                      setPts(next);
                      selectedAdjustmentLayerOrThrow();
                      void applyCurves(next);
                      if (svgRef.hasPointerCapture(e.pointerId)) svgRef.releasePointerCapture(e.pointerId);
                      setDraggingId(null);
                      setHoveredId(null);
                      return;
                    }
                    lastTapTime = now;
                    lastTapId = pt.id;
                    e.preventDefault();
                    svgRef.setPointerCapture(e.pointerId);
                    setDraggingId(pt.id);
                  }}
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
    const hue = () => { const t = hslTab(), h = hsl(); return t === "red" ? h.red_hue : t === "green" ? h.green_hue : h.blue_hue; };
    const sat = () => { const t = hslTab(), h = hsl(); return t === "red" ? h.red_sat : t === "green" ? h.green_sat : h.blue_sat; };
    const lum = () => { const t = hslTab(), h = hsl(); return t === "red" ? h.red_lum : t === "green" ? h.green_lum : h.blue_lum; };
    return (
      <div class="space-y-3">
        <div class="flex gap-1">
          {(["red", "green", "blue"] as const).map((c) => (
            <button
              type="button"
              onClick={() => setHslTab(c)}
              class={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${hslTab() === c ? HSL_TAB_STYLES[c].tabClass : "text-white/28 hover:text-white/50"}`}
            >
              {c}
            </button>
          ))}
        </div>
        <Slider label="Hue"        icon={<HslIcon />}    value={hue()} defaultValue={0} min={-1} max={1} step={0.01} accentColor={accentColor()} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_hue: v } : hslTab() === "green" ? { green_hue: v } : { blue_hue: v }); }} />
        <Slider label="Saturation" icon={<DropletIcon />} value={sat()} defaultValue={0} min={-1} max={1} step={0.01} accentColor={accentColor()} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_sat: v } : hslTab() === "green" ? { green_sat: v } : { blue_sat: v }); }} />
        <Slider label="Luminance"  icon={<ToneIcon />}   value={lum()} defaultValue={0} min={-1} max={1} step={0.01} accentColor={accentColor()} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_lum: v } : hslTab() === "green" ? { green_lum: v } : { blue_lum: v }); }} />
      </div>
    );
  };

  const adjustmentLayers = () =>
    state.layers.map((layer, idx) => ({ layer, idx })).filter(({ layer }) => layer.kind === "adjustment");

  const selectedFocus = (): MobileLayerFocus =>
    layerFocusTypes().get(state.selectedLayerIdx) ?? "tone";

  const displayedCrop = () => selectedCropLayer()?.crop ?? {
    x: 0,
    y: 0,
    width: state.canvasWidth,
    height: state.canvasHeight,
  };
  const setCropField = (field: "x" | "y" | "width" | "height", value: number) => {
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
    setLayerFocusTypes((prev) => new Map(prev).set(newIdx, focus));
    setIsDrawerOpen(true);
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
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    }
  };

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
    } catch (error) {
      setPresetStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPresetBusy(false);
    }
  };


  const renderLayerBody = () => {
    switch (selectedFocus()) {
      case "tone":
        return (
          <div class="space-y-4">
            <Slider
              label="Exposure"
              icon={<SparkIcon />}
              value={tone().exposure}
              defaultValue={DEFAULT_TONE.exposure}
              min={-5}
              max={5}
              step={0.05}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: value, contrast: tone().contrast, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma }); }}
            />
            <Slider
              label="Gamma"
              icon={<ToneIcon />}
              value={tone().gamma}
              defaultValue={DEFAULT_TONE.gamma}
              min={0.1}
              max={3}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: value }); }}
            />
            <Slider
              label="Contrast"
              icon={<CircleIcon />}
              value={tone().contrast}
              defaultValue={DEFAULT_TONE.contrast}
              min={-1.0}
              max={1.0}
              step={0.01}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: value, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma }); }}
            />
            <Slider
              label="Blacks"
              icon={<ToneIcon />}
              value={tone().blacks}
              defaultValue={DEFAULT_TONE.blacks}
              min={-0.05}
              max={0.1}
              step={0.001}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: value, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma }); }}
            />
            <Slider
              label="Whites"
              icon={<ToneIcon />}
              value={tone().whites}
              defaultValue={DEFAULT_TONE.whites}
              min={-0.1}
              max={0.2}
              step={0.001}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: tone().blacks, whites: value, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma }); }}
            />
            <Slider
              label="Saturation"
              icon={<DropletIcon />}
              value={color().saturation}
              defaultValue={DEFAULT_COLOR.saturation}
              valueLabel={valueLabel(color().saturation)}
              min={0}
              max={2}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: value, temperature: color().temperature, tint: color().tint }); }}
            />
          </div>
        );
      case "curves":
        return <CurvesEditor />;
      case "grain":
        return (
          <Slider
            label="Grain"
            icon={<GrainIcon />}
            value={grain().amount}
            defaultValue={DEFAULT_GRAIN.amount}
            valueLabel={valueLabel(grain().amount)}
            min={0}
            max={1}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "grain", grain_amount: value });
            }}
          />
        );
      case "vignette":
        return (
          <Slider
            label="Vignette"
            icon={<CircleIcon />}
            value={vignette().amount}
            defaultValue={DEFAULT_VIGNETTE.amount}
            valueLabel={valueLabel(vignette().amount)}
            min={0}
            max={1}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "vignette", vignette_amount: value });
            }}
          />
        );
      case "sharpen":
        return (
          <Slider
            label="Sharpen"
            icon={<DropletIcon />}
            value={sharpen().amount}
            defaultValue={DEFAULT_SHARPEN.amount}
            valueLabel={valueLabel(sharpen().amount)}
            min={0}
            max={1}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "sharpen", sharpen_amount: value });
            }}
          />
        );
      case "hsl":
        return <HslSection />;
    }
  };

  const CropPanel: Component = () => {
    const crop = () => displayedCrop();
    const hasCropLayer = () => findCropLayerIdx() >= 0;

    return (
      <div class="mb-5 border border-white/8 bg-white/[0.03] p-3">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-[13px] font-medium text-white/82">
            <span class="text-white/42 [&>svg]:h-4 [&>svg]:w-4"><CropIcon /></span>
            <span>Crop</span>
          </div>
          <span class="text-[11px] font-semibold tracking-[0.03em] text-white/45">
            {crop().width} × {crop().height}
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          {(["x", "y", "width", "height"] as const).map((field) => (
            <label class="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/36">
              <span>{field}</span>
              <input
                type="number"
                value={crop()[field]}
                disabled={!selectedCropLayer()}
                min="0"
                step="1"
                onInput={(event) => setCropField(field, event.currentTarget.valueAsNumber)}
                class="min-h-10 border border-white/8 bg-black/30 px-3 text-[13px] font-medium text-white outline-none transition-colors disabled:opacity-45"
              />
            </label>
          ))}
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Show
            when={selectedCropLayer()}
            fallback={
              <button
                type="button"
                onClick={() => {
                  const cropLayerIdx = findCropLayerIdx();
                  if (cropLayerIdx >= 0) {
                    selectLayer(cropLayerIdx);
                    return;
                  }
                  void addLayer("crop");
                }}
                class="min-h-10 border border-white/8 bg-white/[0.04] px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/12 hover:bg-white/[0.08] hover:text-white"
              >
                {hasCropLayer() ? "Select crop" : "Add crop layer"}
              </button>
            }
          >
            <button
              type="button"
              onClick={() => setCropField("x", 0)}
              class="min-h-10 border border-white/8 bg-white/[0.04] px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/12 hover:bg-white/[0.08] hover:text-white"
            >
              Align left
            </button>
            <button
              type="button"
              onClick={() => {
                void applyEdit({
                  layer_idx: state.selectedLayerIdx,
                  op: "crop",
                  crop_x: 0,
                  crop_y: 0,
                  crop_width: state.canvasWidth,
                  crop_height: state.canvasHeight,
                });
              }}
              class="min-h-10 border border-white/8 bg-white/[0.04] px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/12 hover:bg-white/[0.08] hover:text-white"
            >
              Reset
            </button>
          </Show>
        </div>
      </div>
    );
  };

  const PresetsPanel: Component = () => (
    <div class="flex flex-col gap-4 pt-1">
      <div class="flex items-center justify-between gap-3">
        <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Presets</div>
        <button
          type="button"
          onClick={() => void refreshPresetList()}
          class="text-[10px] font-bold uppercase tracking-[0.08em] text-white/40 transition-colors hover:text-white/70"
        >
          Refresh
        </button>
      </div>
      <div class="flex gap-2">
        <input
          type="text"
          value={presetName()}
          onInput={(event) => setPresetName(event.currentTarget.value)}
          placeholder="Preset name"
          class="min-h-10 flex-1 border border-white/8 bg-black/30 px-3 text-[13px] font-medium text-white outline-none transition-colors placeholder:text-white/20"
        />
        <button
          type="button"
          disabled={isPresetBusy() || state.canvasWidth <= 0}
          onClick={() => void handleSavePreset()}
          class="min-h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-[10px] font-bold uppercase tracking-[0.05em] text-white/70 transition-colors hover:border-white/18 hover:bg-white/[0.08] hover:text-stone-100 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      <Show when={presetStatus()}>
        {(status) => <div class="text-[11px] font-medium text-white/45">{status()}</div>}
      </Show>
      <div class="flex flex-col gap-2">
        <Show
          when={presets().length > 0}
          fallback={<div class="border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-sm text-white/38">No presets saved yet.</div>}
        >
          {presets().map((preset) => (
            <div class="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
              <div class="min-w-0 flex-1 truncate text-[13px] font-semibold text-white/80">{preset.name}</div>
              <button
                type="button"
                disabled={isPresetBusy() || state.canvasWidth <= 0}
                onClick={() => void handleLoadPreset(preset.name)}
                class="rounded-lg border border-white/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.05em] text-white/65 transition-colors hover:border-white/18 hover:bg-white/[0.08] hover:text-stone-100 disabled:opacity-40"
              >
                Load
              </button>
            </div>
          ))}
        </Show>
      </div>
    </div>
  );

  const InspectorTabs: Component<{ class?: string }> = (props) => (
    <div class={props.class ?? ""}>
      <div class="flex gap-1 rounded-xl border border-white/8 bg-white/[0.03] p-1">
        {(["edit", "presets"] as const).map((tab) => (
          <button
            type="button"
            onClick={() => setInspectorTab(tab)}
            class={`flex-1 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors ${
              inspectorTab() === tab ? "bg-white/10 text-stone-100" : "text-white/34 hover:text-white/60"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
    </div>
  );

  const DesktopEditPanel: Component = () => (
    <div>
      <div class="mb-4">
        <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Layers</div>
        <div class="mt-3 flex flex-col gap-1">
          {[...state.layers].reverse().map((layer, reverseIdx) => {
            const realIdx = state.layers.length - 1 - reverseIdx;
            const layerName = layer.kind === "image"
              ? "Image"
              : layer.kind === "crop"
                ? "Crop"
              : layer.adjustments?.curves
                ? "Curves"
                : "Adjustment";
            return (
              <div
                class={`flex min-h-9 w-full items-center gap-2 border px-2.5 py-1.5 text-left text-white/76 transition-colors ${
                  state.selectedLayerIdx === realIdx
                    ? "border-white/16 bg-white/12 text-white"
                    : "border-white/5 bg-white/[0.025] hover:border-white/10 hover:bg-white/[0.05]"
                }`}
              >
                <span
                  class={`inline-flex w-4 items-center justify-center text-xs leading-none ${layer.visible ? "text-stone-100" : "text-white/30"}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void setLayerVisible(realIdx, !layer.visible);
                  }}
                >
                  {layer.visible ? "●" : "○"}
                </span>
                <button
                  type="button"
                  onClick={() => selectLayer(realIdx)}
                  class="min-w-0 flex-1 truncate text-left text-[13px] font-semibold tracking-[-0.01em]"
                >
                  {layerName}
                </button>
                <Show when={layer.kind !== "image"}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteLayer(realIdx);
                    }}
                    class="inline-flex h-5 w-5 items-center justify-center text-white/28 transition-colors hover:text-white"
                    title="Delete layer"
                  >
                    <TrashIcon />
                  </button>
                </Show>
                <span class="text-[11px] text-white/34">{realIdx + 1}</span>
              </div>
            );
          })}
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void addLayer("adjustment")}
            class="flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-xl border border-white/10 bg-white/[0.03] px-2 py-2 text-[9px] font-bold uppercase tracking-[0.05em] text-white/60 transition-colors hover:border-white/18 hover:bg-white/[0.08] hover:text-stone-100"
          >
            <span class="[&>svg]:h-4 [&>svg]:w-4"><SparkIcon /></span>
            <span>Add Adjustments</span>
          </button>
          <button
            type="button"
            onClick={() => void addLayer("crop")}
            class="flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-xl border border-white/10 bg-white/[0.03] px-2 py-2 text-[9px] font-bold uppercase tracking-[0.05em] text-white/60 transition-colors hover:border-white/18 hover:bg-white/[0.08] hover:text-stone-100"
          >
            <span class="[&>svg]:h-4 [&>svg]:w-4"><CropIcon /></span>
            <span>Add Crop</span>
          </button>
        </div>
      </div>
      <InspectorTabs class="mb-4" />
    </div>
  );

  return (
    <aside class="lg:w-[340px] lg:flex-none lg:block">
      <div class="hidden h-full border-l border-white/6 bg-[#111111]/92 lg:flex lg:flex-col">
        <div class="flex-1 overflow-y-auto px-4 py-4">
          <DesktopEditPanel />
          {inspectorTab() === "presets"
            ? <PresetsPanel />
            : (
              <Show
                when={selectedCropLayer()}
                fallback={
                  <Show
                    when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
                    fallback={
                      <div class="border border-dashed border-white/14 bg-white/[0.03] px-4 py-4 text-center text-sm text-white/42">
                        Open an image and select a layer to edit.
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-3">
                      <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Adjustments</div>
                      <Slider
                        label="Exposure"
                        icon={<SparkIcon />}
                        value={tone().exposure}
                        defaultValue={DEFAULT_TONE.exposure}
                        min={-5}
                        max={5}
                        step={0.05}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: value, contrast: tone().contrast, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma });
                        }}
                      />
                      <Slider
                        label="Gamma"
                        icon={<ToneIcon />}
                        value={tone().gamma}
                        defaultValue={DEFAULT_TONE.gamma}
                        min={0.1}
                        max={3}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: value });
                        }}
                      />
                      <Slider
                        label="Contrast"
                        icon={<CircleIcon />}
                        value={tone().contrast}
                        defaultValue={DEFAULT_TONE.contrast}
                        min={-1.0}
                        max={1.0}
                        step={0.01}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: value, blacks: tone().blacks, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma });
                        }}
                      />
                      <Slider
                        label="Blacks"
                        icon={<ToneIcon />}
                        value={tone().blacks}
                        defaultValue={DEFAULT_TONE.blacks}
                        min={-0.05}
                        max={0.1}
                        step={0.001}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: value, whites: tone().whites, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma });
                        }}
                      />
                      <Slider
                        label="Whites"
                        icon={<ToneIcon />}
                        value={tone().whites}
                        defaultValue={DEFAULT_TONE.whites}
                        min={-0.1}
                        max={0.2}
                        step={0.001}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "tone", exposure: tone().exposure, contrast: tone().contrast, blacks: tone().blacks, whites: value, highlights: tone().highlights, shadows: tone().shadows, gamma: tone().gamma });
                        }}
                      />
                      <Slider
                        label="Saturation"
                        icon={<DropletIcon />}
                        value={color().saturation}
                        defaultValue={DEFAULT_COLOR.saturation}
                        valueLabel={valueLabel(color().saturation)}
                        min={0}
                        max={2}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: value, temperature: color().temperature, tint: color().tint });
                        }}
                      />
                      <Slider
                        label="Temperature"
                        icon={<ToneIcon />}
                        value={color().temperature}
                        defaultValue={DEFAULT_COLOR.temperature}
                        valueLabel={valueLabel(color().temperature)}
                        min={-1}
                        max={1}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: color().saturation, temperature: value, tint: color().tint });
                        }}
                      />
                      <Slider
                        label="Tint"
                        icon={<ToneIcon />}
                        value={color().tint}
                        defaultValue={DEFAULT_COLOR.tint}
                        valueLabel={valueLabel(color().tint)}
                        min={-1}
                        max={1}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: color().saturation, temperature: color().temperature, tint: value });
                        }}
                      />
                      <CurvesEditor />
                      <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">HSL Color Balance</div>
                      <HslSection />
                      <Slider
                        label="Vignette"
                        icon={<CircleIcon />}
                        value={vignette().amount}
                        defaultValue={DEFAULT_VIGNETTE.amount}
                        valueLabel={valueLabel(vignette().amount)}
                        min={0}
                        max={1}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "vignette", vignette_amount: value });
                        }}
                      />
                      <Slider
                        label="Sharpen"
                        icon={<ToneIcon />}
                        value={sharpen().amount}
                        defaultValue={DEFAULT_SHARPEN.amount}
                        valueLabel={valueLabel(sharpen().amount)}
                        min={0}
                        max={2}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "sharpen", sharpen_amount: value });
                        }}
                      />
                      <Slider
                        label="Grain"
                        icon={<GrainIcon />}
                        value={grain().amount}
                        defaultValue={DEFAULT_GRAIN.amount}
                        valueLabel={valueLabel(grain().amount)}
                        min={0}
                        max={1}
                        onChange={(value) => {
                          selectedAdjustmentLayerOrThrow();
                          void applyEdit({ layer_idx: state.selectedLayerIdx, op: "grain", grain_amount: value });
                        }}
                      />
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
        class={`fixed bottom-0 left-0 right-0 z-30  bg-black/50 transition-transform duration-300 ease-out lg:hidden ${
          isDrawerOpen() ? "translate-y-0" : "translate-y-[calc(100%-4.5rem)]"
        }`}
      >
        <div
          class="flex cursor-pointer flex-col items-center px-4 pt-3 pb-1"
          onClick={() => setIsDrawerOpen((v) => !v)}
        >
          <div class="mb-2 h-1.5 w-14 rounded-full bg-white/14" />
        </div>

        <div class="px-4 pb-4">
          <Show when={inspectorTab() === "presets"} fallback={
            <Show
              when={selectedCropLayer()}
              fallback={
                <Show
                  when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
                  fallback={<div class="px-1 pb-6 text-center text-sm text-white/42">Open an image and select a layer to edit.</div>}
                >
                  <div class="px-1">
                    {renderLayerBody()}
                  </div>
                </Show>
              }
            >
              <div class="px-1">
                <CropPanel />
              </div>
            </Show>
          }>
            <div class="px-1">
              <PresetsPanel />
            </div>
          </Show>
        </div>

        {/* Layer tabs + add button */}
        <div class="flex items-center gap-1 overflow-x-auto border-t border-white/6 px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-3">
          {adjustmentLayers().map(({ idx }) => {
            const focus = () => layerFocusTypes().get(idx) ?? "tone";
            const isActive = () => state.selectedLayerIdx === idx && isDrawerOpen();
            return (
              <button
                type="button"
                onClick={() => { selectLayer(idx); setIsDrawerOpen(true); setIsPickerOpen(false); }}
                class={`flex min-w-[3.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
                  isActive() ? "text-stone-100" : "text-white/34"
                }`}
              >
                <span class="[&>svg]:h-5 [&>svg]:w-5">{focusGlyphs[focus()]()}</span>
                <span>{focusLabels[focus()]}</span>
              </button>
            );
          })}
          
          <div class="flex-1"></div>
          
          <button
            type="button"
            onClick={() => setIsPickerOpen((v) => !v)}
            class={`ml-1 flex min-w-[2.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
              isPickerOpen() ? "text-stone-100" : "text-white/34"
            }`}
          >
            <span class="flex h-[24px] w-[24px] items-center justify-center text-lg leading-none">+</span>
            <span>Add</span>
          </button>
          
          <Show when={state.selectedLayerIdx >= 0 && state.layers[state.selectedLayerIdx]?.kind !== "image"}>
            <button
              type="button"
              onClick={() => void handleDeleteSelectedLayer()}
              class="ml-1 flex min-w-[2.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em]"
            >
              <TrashIcon />
              <span>Delete</span>
            </button>
          </Show>
          
        </div>

        <div class="border-t border-white/6 px-4 pb-4 pt-3">
          <InspectorTabs />
        </div>

      </div>

      {/* Add layer dialog */}
      <Show when={isPickerOpen()}>
        <div
          class="fixed bottom-35 right-0 z-50 flex items-center justify-center lg:hidden"
          onClick={() => setIsPickerOpen(false)}
        >
          <div
            class="mx-6 w-full max-w-xs rounded-2xl border border-white/10 bg-[#111111] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="mb-4 text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Add adjustment layer</div>
            <div class="grid grid-rows-6 gap-2">
              {(["tone", "curves", "grain", "vignette", "sharpen", "hsl"] as const).map((focus) => (
                <button
                  type="button"
                  onClick={() => void handleAddLayer(focus)}
                  class="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-3 text-[10px] font-bold uppercase tracking-[0.05em] text-white/60 active:bg-white/10"
                >
                  <span class="[&>svg]:h-5 [&>svg]:w-5">{focusGlyphs[focus]()}</span>
                  <span>{focusLabels[focus]}</span>
                </button>
              ))}
              
              <button
                type="button"
                onClick={() => void setIsPickerOpen(false)}
                class="flex justify-end items-center gap-1.5 rounded-xl px-3 py-3 text-[10px] font-bold uppercase tracking-[0.05em] text-white/60 active:bg-white/10"
              >
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
};

export default Inspector;
