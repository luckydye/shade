import { Component, Show, createSignal } from "solid-js";
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
  const [exposure, setExposure] = createSignal(0);
  const [contrast, setContrast] = createSignal(0);
  const [blacks, setBlacks] = createSignal(0);
  const [highlights, setHighlights] = createSignal(0);
  const [shadows, setShadows] = createSignal(0);
  const [saturation, setSaturation] = createSignal(1);
  const [temperature, setTemperature] = createSignal(0);
  const [tint, setTint] = createSignal(0);
  const [vignetteAmount, setVignetteAmount] = createSignal(0);
  const [sharpenAmount, setSharpenAmount] = createSignal(0);
  const [grainAmount, setGrainAmount] = createSignal(0);

  const sendTone = () =>
    applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "tone",
      exposure: exposure(),
      contrast: contrast(),
      blacks: blacks(),
      highlights: highlights(),
      shadows: shadows(),
    });

  const selectedLayer = () => state.layers[state.selectedLayerIdx];

  return (
    <div class="w-64 bg-panel border-l border-gray-700 flex flex-col overflow-y-auto">
      <div class="p-2 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Inspector
      </div>
      <Show
        when={state.selectedLayerIdx >= 0 && selectedLayer()?.kind === "adjustment"}
        fallback={
          <div class="p-3 text-xs text-gray-500">Select an adjustment layer</div>
        }
      >
        <div class="p-3">
          {/* Tone */}
          <div class="text-xs font-semibold text-gray-300 mb-2">Tone</div>
          <Slider label="Exposure" value={exposure()} min={-3} max={3} onChange={(v) => { setExposure(v); sendTone(); }} />
          <Slider label="Contrast" value={contrast()} min={-1} max={1} onChange={(v) => { setContrast(v); sendTone(); }} />
          <Slider label="Blacks" value={blacks()} min={-0.5} max={0.5} onChange={(v) => { setBlacks(v); sendTone(); }} />
          <Slider label="Highlights" value={highlights()} min={-1} max={1} onChange={(v) => { setHighlights(v); sendTone(); }} />
          <Slider label="Shadows" value={shadows()} min={-1} max={1} onChange={(v) => { setShadows(v); sendTone(); }} />

          {/* Color */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Color</div>
          <Slider
            label="Saturation"
            value={saturation()}
            min={0}
            max={2}
            onChange={(v) => {
              setSaturation(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: v, temperature: temperature(), tint: tint() });
            }}
          />
          <Slider
            label="Temperature"
            value={temperature()}
            min={-1}
            max={1}
            onChange={(v) => {
              setTemperature(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: saturation(), temperature: v, tint: tint() });
            }}
          />
          <Slider
            label="Tint"
            value={tint()}
            min={-1}
            max={1}
            onChange={(v) => {
              setTint(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "color", saturation: saturation(), temperature: temperature(), tint: v });
            }}
          />

          {/* Vignette */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Vignette</div>
          <Slider
            label="Amount"
            value={vignetteAmount()}
            min={0}
            max={1}
            onChange={(v) => {
              setVignetteAmount(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "vignette", vignette_amount: v });
            }}
          />

          {/* Sharpen */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Sharpen</div>
          <Slider
            label="Amount"
            value={sharpenAmount()}
            min={0}
            max={2}
            onChange={(v) => {
              setSharpenAmount(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "sharpen", sharpen_amount: v });
            }}
          />

          {/* Grain */}
          <div class="text-xs font-semibold text-gray-300 mb-2 mt-4">Grain</div>
          <Slider
            label="Amount"
            value={grainAmount()}
            min={0}
            max={1}
            onChange={(v) => {
              setGrainAmount(v);
              applyEdit({ layer_idx: state.selectedLayerIdx, op: "grain", grain_amount: v });
            }}
          />
        </div>
      </Show>
    </div>
  );
};

export default Inspector;
