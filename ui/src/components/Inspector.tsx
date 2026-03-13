import { Component, JSX, Show, createEffect, createSignal } from "solid-js";
import { addLayer, applyEdit, selectLayer, setLayerVisible, state } from "../store/editor";

type MobileTab = "brightness" | "contrast" | "saturation" | "curves" | "grain";

interface SliderProps {
  label: string;
  icon: JSX.Element;
  value: number;
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
      class="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/18 accent-white"
    />
  </div>
);

const CURVE_SAMPLE_INDICES = [64, 128, 192] as const;
const IDENTITY_LUT = Array.from({ length: 256 }, (_, idx) => idx / 255);

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

const tabGlyphs: Record<MobileTab, JSX.Element> = {
  brightness: <SparkIcon />,
  contrast: <CircleIcon />,
  saturation: <DropletIcon />,
  curves: <CurveIcon />,
  grain: <GrainIcon />,
};

const tabLabels: Record<MobileTab, string> = {
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  curves: "Curves",
  grain: "Grain",
};

const Inspector: Component = () => {
  const [activeTab, setActiveTab] = createSignal<MobileTab>("brightness");
  let previousSelectedIdx = -1;

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
    exposure: 0,
    contrast: 0,
    blacks: 0,
    highlights: 0,
    shadows: 0,
  };
  const curves = () => selectedAdjustmentLayer()?.adjustments?.curves ?? {
    lut_r: IDENTITY_LUT,
    lut_g: IDENTITY_LUT,
    lut_b: IDENTITY_LUT,
    lut_master: IDENTITY_LUT,
    per_channel: false,
  };
  const color = () => selectedAdjustmentLayer()?.adjustments?.color ?? {
    saturation: 1,
    temperature: 0,
    tint: 0,
  };
  const vignette = () => selectedAdjustmentLayer()?.adjustments?.vignette ?? { amount: 0 };
  const sharpen = () => selectedAdjustmentLayer()?.adjustments?.sharpen ?? { amount: 0 };
  const grain = () => selectedAdjustmentLayer()?.adjustments?.grain ?? { amount: 0 };

  const applyTone = (next: Partial<ReturnType<typeof tone>>) => {
    const current = tone();
    return applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "tone",
      exposure: next.exposure ?? current.exposure,
      contrast: next.contrast ?? current.contrast,
      blacks: next.blacks ?? current.blacks,
      highlights: next.highlights ?? current.highlights,
      shadows: next.shadows ?? current.shadows,
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

  const curveSamples = () => CURVE_SAMPLE_INDICES.map((idx) => curves().lut_master[idx]);

  createEffect(() => {
    const currentIdx = state.selectedLayerIdx;
    if (currentIdx === previousSelectedIdx) return;
    previousSelectedIdx = currentIdx;
    setActiveTab(selectedAdjustmentLayer()?.adjustments?.curves ? "curves" : "brightness");
  });

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

  const renderMobileBody = () => {
    switch (activeTab()) {
      case "brightness":
        return (
          <Slider
            label="Brightness"
            icon={<SparkIcon />}
            value={tone().exposure}
            valueLabel={valueLabel(tone().exposure, 40)}
            min={-3}
            max={3}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyTone({ exposure: value });
            }}
          />
        );
      case "contrast":
        return (
          <Slider
            label="Contrast"
            icon={<CircleIcon />}
            value={tone().contrast}
            valueLabel={valueLabel(tone().contrast)}
            min={-1}
            max={1}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyTone({ contrast: value });
            }}
          />
        );
      case "saturation":
        return (
          <Slider
            label="Saturation"
            icon={<DropletIcon />}
            value={color().saturation}
            valueLabel={valueLabel(color().saturation)}
            min={0}
            max={2}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyColor({ saturation: value });
            }}
          />
        );
      case "curves":
        return renderCurves();
      case "grain":
        return (
          <Slider
            label="Grain"
            icon={<GrainIcon />}
            value={grain().amount}
            valueLabel={valueLabel(grain().amount)}
            min={0}
            max={1}
            onChange={(value) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "grain", grain_amount: value });
            }}
          />
        );
    }
  };

  return (
    <aside class="lg:w-[340px] lg:flex-none">
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
                label="Brightness"
                icon={<SparkIcon />}
                value={tone().exposure}
                valueLabel={valueLabel(tone().exposure, 40)}
                min={-3}
                max={3}
                onChange={(value) => {
                  selectedAdjustmentLayerOrThrow();
                  void applyTone({ exposure: value });
                }}
              />
              <Slider
                label="Contrast"
                icon={<CircleIcon />}
                value={tone().contrast}
                valueLabel={valueLabel(tone().contrast)}
                min={-1}
                max={1}
                onChange={(value) => {
                  selectedAdjustmentLayerOrThrow();
                  void applyTone({ contrast: value });
                }}
              />
              <Slider
                label="Saturation"
                icon={<DropletIcon />}
                value={color().saturation}
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
                valueLabel={valueLabel(color().tint)}
                min={-1}
                max={1}
                onChange={(value) => {
                  selectedAdjustmentLayerOrThrow();
                  void applyColor({ tint: value });
                }}
              />
              {renderCurves()}
              <Slider
                label="Vignette"
                icon={<CircleIcon />}
                value={vignette().amount}
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

      <div class="border-t border-white/6 bg-[linear-gradient(180deg,rgba(17,17,17,0.98),rgba(14,14,14,0.98))] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4 shadow-[0_-24px_60px_rgba(0,0,0,0.42)] lg:hidden">
        <div class="mx-auto mb-4 h-1.5 w-14 rounded-full bg-white/14" />
        <Show
          when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
          fallback={<div class="px-1 pb-6 text-center text-sm text-white/42">Open an image to start adjusting.</div>}
        >
          <div class="px-1">
            <div class="mb-5 flex items-center justify-between">
              <div>
                <div class="text-[30px] font-semibold tracking-[-0.04em] text-white">{tabLabels[activeTab()]}</div>
                <div class="text-sm text-white/38">Selected layer reacts live as you drag.</div>
              </div>
              <span class="bg-black px-4 py-2 text-sm font-semibold text-white/80">
                {activeTab() === "brightness" && valueLabel(tone().exposure, 40)}
                {activeTab() === "contrast" && valueLabel(tone().contrast)}
                {activeTab() === "saturation" && valueLabel(color().saturation)}
                {activeTab() === "curves" && "CURVE"}
                {activeTab() === "grain" && valueLabel(grain().amount)}
              </span>
            </div>
            <div class="pb-6">{renderMobileBody()}</div>
          </div>
        </Show>

        <div class="mt-2 grid grid-cols-5 gap-1 border-t border-white/6 pt-4">
          {(["brightness", "contrast", "saturation", "curves", "grain"] as const).map((tab) => (
            <button
              type="button"
              onClick={() => setActiveTab(tab)}
              class={`flex flex-col items-center gap-1 px-0.5 pt-2 text-[10px] font-bold uppercase tracking-[0.05em] ${
                activeTab() === tab ? "text-stone-100" : "text-white/34"
              }`}
            >
              <span class="[&>svg]:h-5 [&>svg]:w-5">{tabGlyphs[tab]}</span>
              <span>{tabLabels[tab]}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
};

export default Inspector;
