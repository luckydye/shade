import {
  type Component,
  createEffect,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Slider } from "./Slider";
import type { LayerInfo } from "../store/editor";
import {
  addLayer,
  applyEdit,
  applyGradientMask,
  createBrushMask,
  cropAspectRatioPreset,
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
  setCropAspectRatioPreset,
  setIsAdjustmentSliderActive,
  setIsDrawerOpen,
  setLayerVisible,
  state,
} from "../store/editor";
import {
  type ArtboardSource,
  getLayerDefaultName,
  getLayerDisplayName,
  getSelectedArtboard,
} from "../store/editor-store";
import { Button } from "./Button";
import {
  clampAspectSize,
  CROP_ASPECT_RATIO_OPTIONS,
  fitCropRectToAspectRatio,
  resolveCropAspectRatio,
  type CropAspectRatioPreset,
} from "../crop-aspect";
import { CurvesEditor } from "./inspector/CurvesEditor";
import { LsCurveEditor } from "./inspector/LsCurveEditor";
import {
  ADD_LAYER_FOCI,
  DEFAULT_COLOR,
  DEFAULT_CURVES,
  DEFAULT_DENOISE,
  DEFAULT_GLOW,
  DEFAULT_GRAIN,
  DEFAULT_HSL,
  DEFAULT_SHARPEN,
  DEFAULT_TONE,
  DEFAULT_VIGNETTE,
  focusLabels,
  HSL_TAB_STYLES,
  inferFocus,
  type MobileLayerFocus,
} from "./inspector/inspector-constants";
import {
  circleSvg,
  cropSvg,
  denoiseSvg,
  dropletSvg,
  focusGlyphs,
  grainSvg,
  hslSvg,
  sparkSvg,
  toneSvg,
  trashSvg,
} from "./inspector/inspector-icons";
import {
  CURVE_SAMPLE_INDICES,
  IDENTITY_LUT,
  LS_CURVE_IDENTITY,
  normalizeLsPoints,
  normalizePoints,
  type ControlPoint,
  valueLabel,
} from "./inspector/curve-utils";

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

const LayerTypeIcon: Component<{ layer: LayerInfo }> = (props) => {
  if (props.layer.kind === "crop") {
    return (
      <span
        class="flex h-4 w-4 items-center justify-center text-[var(--text-dim)] [&>svg]:h-4 [&>svg]:w-4"
        innerHTML={cropSvg}
      />
    );
  }
  if (props.layer.kind === "adjustment") {
    return (
      <span
        class="flex h-4 w-4 items-center justify-center text-[var(--text-dim)] [&>svg]:h-4 [&>svg]:w-4"
        innerHTML={sparkSvg}
      />
    );
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
    const normalizedPoints = normalizeLsPoints(points);
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
  const selectedCropAspectRatio = () =>
    resolveCropAspectRatio(cropAspectRatioPreset(), state.canvasWidth, state.canvasHeight);
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
    const aspectRatio = selectedCropAspectRatio();
    const maxWidth = state.canvasWidth - crop.x;
    const maxHeight = state.canvasHeight - crop.y;
    if (maxWidth <= 0 || maxHeight <= 0) {
      throw new Error("crop bounds exceed canvas dimensions");
    }
    let nextWidth = crop.width;
    let nextHeight = crop.height;
    if (aspectRatio && (field === "width" || field === "height")) {
      if (field === "width") {
        const size = clampAspectSize(
          value,
          value / aspectRatio,
          aspectRatio,
          maxWidth,
          maxHeight,
          "width",
        );
        nextWidth = size.width;
        nextHeight = size.height;
      } else {
        const size = clampAspectSize(
          value * aspectRatio,
          value,
          aspectRatio,
          maxWidth,
          maxHeight,
          "height",
        );
        nextWidth = size.width;
        nextHeight = size.height;
      }
    }
    void applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "crop",
      crop_x: field === "x" ? value : crop.x,
      crop_y: field === "y" ? value : crop.y,
      crop_width:
        field === "width" || field === "height" ? nextWidth : crop.width,
      crop_height:
        field === "width" || field === "height" ? nextHeight : crop.height,
      crop_rotation: field === "rotation" ? value : crop.rotation,
    });
  };
  const applyCropAspectRatioPreset = async (preset: CropAspectRatioPreset) => {
    setCropAspectRatioPreset(preset);
    const cropLayer = selectedCropLayer();
    if (!cropLayer?.crop) {
      return;
    }
    const ratio = resolveCropAspectRatio(
      preset,
      state.canvasWidth,
      state.canvasHeight,
    );
    if (!ratio) {
      return;
    }
    const nextCrop = fitCropRectToAspectRatio(
      cropLayer.crop,
      ratio,
      state.canvasWidth,
      state.canvasHeight,
    );
    await applyEdit({
      layer_idx: state.selectedLayerIdx,
      op: "crop",
      crop_x: nextCrop.x,
      crop_y: nextCrop.y,
      crop_width: nextCrop.width,
      crop_height: nextCrop.height,
      crop_rotation: nextCrop.rotation,
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
          <CurvesEditor
            curvePointCache={curvePointCache}
            defaultCurvePoints={defaultCurvePoints}
            onApplyCurves={applyCurves}
            parameterRowClass={PARAMETER_ROW_CLASS}
          />
        </Match>
        <Match when={selectedFocus() === "ls_curve"}>
          <LsCurveEditor
            lsCurvePointCache={lsCurvePointCache}
            defaultLsCurvePoints={defaultLsCurvePoints}
            onApplyLsCurve={applyLsCurve}
            parameterRowClass={PARAMETER_ROW_CLASS}
          />
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
        <label class="flex flex-col gap-1">
          <span class={SECTION_TITLE_CLASS}>Aspect Ratio</span>
          <select
            value={cropAspectRatioPreset()}
            disabled={!selectedCropLayer()}
            onChange={(event) =>
              void applyCropAspectRatioPreset(
                event.currentTarget.value as CropAspectRatioPreset,
              )
            }
            class={INPUT_CLASS}
          >
            <For each={CROP_ASPECT_RATIO_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        </label>
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
                <LayerTypeIcon layer={layer} />
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
                <Show
                  when={layer.kind !== "crop"}
                  fallback={<span />}
                >
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
                    <span
                      class="flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4"
                      innerHTML={trashSvg}
                    />
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
                <CurvesEditor
                  curvePointCache={curvePointCache}
                  defaultCurvePoints={defaultCurvePoints}
                  onApplyCurves={applyCurves}
                  parameterRowClass={PARAMETER_ROW_CLASS}
                />
              </ControlSection>
              <ControlSection title="Color">
                <WhiteBalanceSliders />
                <SaturationSliders />
                <LsCurveEditor
                  lsCurvePointCache={lsCurvePointCache}
                  defaultLsCurvePoints={defaultLsCurvePoints}
                  onApplyLsCurve={applyLsCurve}
                  parameterRowClass={PARAMETER_ROW_CLASS}
                />
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
                  <span
                    class="flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5"
                    innerHTML={trashSvg}
                  />
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
