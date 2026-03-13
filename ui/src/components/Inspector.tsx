import { Component, JSX, Show, createEffect, createSignal } from "solid-js";
import { addLayer, applyEdit, isDrawerOpen, selectLayer, setIsDrawerOpen, setLayerVisible, state } from "../store/editor";

type MobileLayerFocus = "tone" | "curves" | "grain" | "vignette" | "sharpen" | "hsl";

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
      class="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/18 accent-white"
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildMasterCurveLut(samples: readonly number[]) {
  if (samples.length !== CURVE_SAMPLE_INDICES.length) {
    throw new Error("invalid curve sample count");
  }
  const anchors = [
    { x: 0, y: 0 },
    ...CURVE_SAMPLE_INDICES.map((x, idx) => ({ x, y: clamp(samples[idx], 0, 1) })),
    { x: 255, y: 1 },
  ];
  const lut = new Array<number>(256);
  for (let segmentIdx = 0; segmentIdx < anchors.length - 1; segmentIdx += 1) {
    const start = anchors[segmentIdx];
    const end = anchors[segmentIdx + 1];
    const span = end.x - start.x;
    if (span <= 0) throw new Error("curve anchors must be strictly increasing");
    for (let x = start.x; x <= end.x; x += 1) {
      const t = (x - start.x) / span;
      lut[x] = start.y + (end.y - start.y) * t;
    }
  }
  return lut;
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
  const [isPickerOpen, setIsPickerOpen] = createSignal(false);
  const [hslTab, setHslTab] = createSignal<"red" | "green" | "blue">("red");

  const selectedLayer = () => state.layers[state.selectedLayerIdx];
  const selectedAdjustmentLayer = () => {
    const layer = selectedLayer();
    return layer?.kind === "adjustment" ? layer : null;
  };
  const selectedAdjustmentLayerOrThrow = () => {
    const layer = selectedAdjustmentLayer();
    if (!layer) throw new Error("selected layer is not an adjustment layer");
    return layer;
  };

  const tone = () => selectedAdjustmentLayer()?.adjustments?.tone ?? {
    ...DEFAULT_TONE,
  };
  const curves = () => selectedAdjustmentLayer()?.adjustments?.curves ?? DEFAULT_CURVES;
  const color = () => selectedAdjustmentLayer()?.adjustments?.color ?? DEFAULT_COLOR;
  const vignette = () => selectedAdjustmentLayer()?.adjustments?.vignette ?? DEFAULT_VIGNETTE;
  const sharpen = () => selectedAdjustmentLayer()?.adjustments?.sharpen ?? DEFAULT_SHARPEN;
  const grain = () => selectedAdjustmentLayer()?.adjustments?.grain ?? DEFAULT_GRAIN;
  const hsl = () => selectedAdjustmentLayer()?.adjustments?.hsl ?? DEFAULT_HSL;

  const applyTone = (next: Partial<ReturnType<typeof tone>>) => {
    const current = tone();
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "tone",
      exposure: next.exposure ?? current.exposure,
      contrast: next.contrast ?? current.contrast,
      blacks: next.blacks ?? current.blacks,
      whites: next.whites ?? current.whites,
      highlights: next.highlights ?? current.highlights,
      shadows: next.shadows ?? current.shadows,
      gamma: next.gamma ?? current.gamma,
    });
  };

  const applyColor = (next: Partial<ReturnType<typeof color>>) => {
    const current = color();
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "color",
      saturation: next.saturation ?? current.saturation,
      temperature: next.temperature ?? current.temperature,
      tint: next.tint ?? current.tint,
    });
  };

  const applyCurves = (samples: readonly number[]) => {
    const lutMaster = buildMasterCurveLut(samples);
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "curves",
      lut_r: IDENTITY_LUT,
      lut_g: IDENTITY_LUT,
      lut_b: IDENTITY_LUT,
      lut_master: lutMaster,
      per_channel: false,
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

  const curveSamples = () => CURVE_SAMPLE_INDICES.map((idx) => curves().lut_master[idx]);

  // Defined as a component (not a plain function) so SolidJS gives it a stable reactive
  // boundary. Plain function calls like {renderFn()} are wrapped in a single reactive
  // computation and replace their entire DOM subtree on any signal change — which kills
  // an active drag. A component (<HslSection />) gets fine-grained in-place updates.
  const HslSection: Component = () => {
    const tabColors = { red: "text-red-400 bg-red-500/15", green: "text-green-400 bg-green-500/15", blue: "text-blue-400 bg-blue-500/15" } as const;
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
              class={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ${hslTab() === c ? tabColors[c] : "text-white/28 hover:text-white/50"}`}
            >
              {c}
            </button>
          ))}
        </div>
        <Slider label="Hue"        icon={<HslIcon />}    value={hue()} defaultValue={0} min={-1} max={1} step={0.01} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_hue: v } : hslTab() === "green" ? { green_hue: v } : { blue_hue: v }); }} />
        <Slider label="Saturation" icon={<DropletIcon />} value={sat()} defaultValue={0} min={-1} max={1} step={0.01} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_sat: v } : hslTab() === "green" ? { green_sat: v } : { blue_sat: v }); }} />
        <Slider label="Luminance"  icon={<ToneIcon />}   value={lum()} defaultValue={0} min={-1} max={1} step={0.01} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyHsl(hslTab() === "red" ? { red_lum: v } : hslTab() === "green" ? { green_lum: v } : { blue_lum: v }); }} />
      </div>
    );
  };

  const adjustmentLayers = () =>
    state.layers.map((layer, idx) => ({ layer, idx })).filter(({ layer }) => layer.kind === "adjustment");

  const selectedFocus = (): MobileLayerFocus =>
    layerFocusTypes().get(state.selectedLayerIdx) ?? "tone";

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

  const renderCurves = () => (
    <div class="py-1">
      <div class="mb-1 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[13px] font-medium text-white/82">
          <span class="text-white/42 [&>svg]:h-4 [&>svg]:w-4">
            <CurveIcon />
          </span>
          <span>Curves</span>
        </div>
        <span class="text-[11px] font-semibold tracking-[0.03em] text-white/62">Master</span>
      </div>
      <svg viewBox="0 0 100 100" class="mb-2 block h-24 w-full bg-transparent">
        <path d="M 0 100 L 100 0" stroke="#525252" stroke-width="1" fill="none" />
        <path d={curvePath(curves().lut_master)} stroke="#f5f5f4" stroke-width="2" fill="none" />
      </svg>
      <div class="space-y-2">
        <Slider
          label="Shadows"
          icon={<SparkIcon />}
          value={curveSamples()[0]}
          defaultValue={IDENTITY_LUT[CURVE_SAMPLE_INDICES[0]]}
          valueLabel={valueLabel(curveSamples()[0])}
          min={0}
          max={1}
          onChange={(value) => {
            selectedAdjustmentLayerOrThrow();
            const samples = curveSamples();
            samples[0] = value;
            void applyCurves(samples);
          }}
        />
        <Slider
          label="Midtones"
          icon={<ToneIcon />}
          value={curveSamples()[1]}
          defaultValue={IDENTITY_LUT[CURVE_SAMPLE_INDICES[1]]}
          valueLabel={valueLabel(curveSamples()[1])}
          min={0}
          max={1}
          onChange={(value) => {
            selectedAdjustmentLayerOrThrow();
            const samples = curveSamples();
            samples[1] = value;
            void applyCurves(samples);
          }}
        />
        <Slider
          label="Highlights"
          icon={<CircleIcon />}
          value={curveSamples()[2]}
          defaultValue={IDENTITY_LUT[CURVE_SAMPLE_INDICES[2]]}
          valueLabel={valueLabel(curveSamples()[2])}
          min={0}
          max={1}
          onChange={(value) => {
            selectedAdjustmentLayerOrThrow();
            const samples = curveSamples();
            samples[2] = value;
            void applyCurves(samples);
          }}
        />
      </div>
    </div>
  );

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
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyTone({ exposure: value }); }}
            />
            <Slider
              label="Gamma"
              icon={<ToneIcon />}
              value={tone().gamma}
              defaultValue={DEFAULT_TONE.gamma}
              min={0.1}
              max={3}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyTone({ gamma: value }); }}
            />
            <Slider
              label="Contrast"
              icon={<CircleIcon />}
              value={tone().contrast}
              defaultValue={DEFAULT_TONE.contrast}
              min={-1.0}
              max={1.0}
              step={0.01}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyTone({ contrast: value }); }}
            />
            <Slider
              label="Blacks"
              icon={<ToneIcon />}
              value={tone().blacks}
              defaultValue={DEFAULT_TONE.blacks}
              min={-0.05}
              max={0.1}
              step={0.001}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyTone({ blacks: value }); }}
            />
            <Slider
              label="Whites"
              icon={<ToneIcon />}
              value={tone().whites}
              defaultValue={DEFAULT_TONE.whites}
              min={-0.1}
              max={0.2}
              step={0.001}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyTone({ whites: value }); }}
            />
            <Slider
              label="Saturation"
              icon={<DropletIcon />}
              value={color().saturation}
              defaultValue={DEFAULT_COLOR.saturation}
              valueLabel={valueLabel(color().saturation)}
              min={0}
              max={2}
              onChange={(value) => { selectedAdjustmentLayerOrThrow(); void applyColor({ saturation: value }); }}
            />
          </div>
        );
      case "curves":
        return renderCurves();
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

  return (
    <aside class="lg:w-[340px] lg:flex-none lg:block">
      <div class="hidden h-full border-l border-white/6 bg-[#111111]/92 lg:flex lg:flex-col">
        <div class="flex-1 overflow-y-auto px-4 py-4">
          <div class="mb-4">
            <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30">Layers</div>
            <div class="mt-3 flex flex-col gap-1">
              {[...state.layers].reverse().map((layer, reverseIdx) => {
                const realIdx = state.layers.length - 1 - reverseIdx;
                const layerName = layer.kind === "image"
                  ? "Image"
                  : layer.adjustments?.curves
                    ? "Curves"
                    : "Adjustment";
                return (
                  <button
                    type="button"
                    onClick={() => selectLayer(realIdx)}
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
                    <span class="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]">
                      {layerName}
                    </span>
                    <span class="text-[11px] text-white/34">{realIdx + 1}</span>
                  </button>
                );
              })}
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void addLayer("adjustment")}
                class="min-h-10 border border-white/6 bg-white/[0.04] px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/12 hover:bg-white/[0.08] hover:text-white"
              >
                Add Tone
              </button>
              <button
                type="button"
                onClick={() => void addLayer("curves")}
                class="min-h-10 border border-white/6 bg-white/[0.04] px-3 text-[12px] font-semibold text-white/80 transition-colors hover:border-white/12 hover:bg-white/[0.08] hover:text-white"
              >
                Add Curves
              </button>
            </div>
          </div>

          <Show
            when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
            fallback={
              <div class="border border-dashed border-white/14 bg-white/[0.03] px-4 py-4 text-center text-sm text-white/42">
                Open an image to unlock live adjustments.
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
                  void applyTone({ exposure: value });
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
                  void applyTone({ gamma: value });
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
                  void applyTone({ contrast: value });
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
                  void applyTone({ blacks: value });
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
                  void applyTone({ whites: value });
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
                  void applyColor({ saturation: value });
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
                  void applyColor({ temperature: value });
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
                  void applyColor({ tint: value });
                }}
              />
              {renderCurves()}
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
        </div>
      </div>

      {/* Mobile: drawer overlay */}
      <div
        class={`fixed bottom-0 left-0 right-0 z-30 border-t border-white/30 bg-black/50 transition-transform duration-300 ease-out lg:hidden ${
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
          <Show
            when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
            fallback={<div class="px-1 pb-6 text-center text-sm text-white/42">Open an image to start adjusting.</div>}
          >
            <div class="px-1">
              <div class="pb-4">{renderLayerBody()}</div>
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
          <button
            type="button"
            onClick={() => setIsPickerOpen((v) => !v)}
            class={`ml-1 flex min-w-[2.5rem] flex-col items-center gap-1 px-2 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
              isPickerOpen() ? "text-stone-100" : "text-white/34"
            }`}
          >
            <span class="flex h-5 w-5 items-center justify-center text-lg leading-none">+</span>
            <span>Add</span>
          </button>
        </div>

      </div>

      {/* Add layer dialog */}
      <Show when={isPickerOpen()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center lg:hidden"
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
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
};

export default Inspector;
