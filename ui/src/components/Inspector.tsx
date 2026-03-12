import { Component, Show } from "solid-js";
import { state, applyEdit } from "../store/editor";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}

const Slider: Component<SliderProps> = (props) => (
  <div class="flex flex-col gap-0.5 mb-3">
    <div class="flex justify-between text-xs text-gray-400">
      <span>{props.label}</span>
      <span>{props.value.toFixed(2)}</span>
    </div>
    <input
      type="range"
      min={props.min}
      max={props.max}
      step={props.step ?? 0.01}
      value={props.value}
      onInput={(e) => props.onChange(parseFloat(e.currentTarget.value))}
      class="w-full accent-accent h-1"
    />
  </div>
);

const Inspector: Component = () => {
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

  return (
    <div class="w-64 bg-panel border-l border-gray-700 flex flex-col overflow-y-auto">
      <div class="p-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Inspector
      </div>
      <Show
        when={state.selectedLayerIdx >= 0 && selectedAdjustmentLayer()}
        fallback={
          <div class="p-3 text-xs text-gray-500">Select an adjustment layer</div>
        }
      >
        <div class="p-3">
          {/* Tone */}
          <div class="text-xs font-semibold text-gray-300 mb-2">Tone</div>
          <Slider label="Exposure" value={tone().exposure} min={-3} max={3} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyTone({ exposure: v }); }} />
          <Slider label="Contrast" value={tone().contrast} min={-1} max={1} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyTone({ contrast: v }); }} />
          <Slider label="Blacks" value={tone().blacks} min={-0.5} max={0.5} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyTone({ blacks: v }); }} />
          <Slider label="Highlights" value={tone().highlights} min={-1} max={1} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyTone({ highlights: v }); }} />
          <Slider label="Shadows" value={tone().shadows} min={-1} max={1} onChange={(v) => { selectedAdjustmentLayerOrThrow(); void applyTone({ shadows: v }); }} />

          {/* Color */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Color</div>
          <Slider
            label="Saturation"
            value={color().saturation}
            min={0}
            max={2}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyColor({ saturation: v });
            }}
          />
          <Slider
            label="Temperature"
            value={color().temperature}
            min={-1}
            max={1}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyColor({ temperature: v });
            }}
          />
          <Slider
            label="Tint"
            value={color().tint}
            min={-1}
            max={1}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyColor({ tint: v });
            }}
          />

          {/* Vignette */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Vignette</div>
          <Slider
            label="Amount"
            value={vignette().amount}
            min={0}
            max={1}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "vignette", vignette_amount: v });
            }}
          />

          {/* Sharpen */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Sharpen</div>
          <Slider
            label="Amount"
            value={sharpen().amount}
            min={0}
            max={2}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "sharpen", sharpen_amount: v });
            }}
          />

          {/* Grain */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Grain</div>
          <Slider
            label="Amount"
            value={grain().amount}
            min={0}
            max={1}
            onChange={(v) => {
              selectedAdjustmentLayerOrThrow();
              void applyEdit({ layer_idx: state.selectedLayerIdx, op: "grain", grain_amount: v });
            }}
          />
        </div>
      </Show>
    </div>
  );
};

export default Inspector;
