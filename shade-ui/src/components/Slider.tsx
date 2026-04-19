import { type Component, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { clamp } from "../store/editor-store";
import {
  activeAdjustmentSliderId,
  flushDeferredHistorySnapshot,
  isAdjustmentSliderActive,
  refreshFinalPreview,
  setActiveAdjustmentSliderId,
  setIsAdjustmentSliderActive,
} from "../store/editor";

const PARAMETER_ROW_CLASS = "grid grid-cols-[16px_minmax(0,1fr)_56px] gap-x-2 gap-y-0.5 py-0.5";

export const Slider: Component<{
  label: string;
  /** Raw SVG markup string rendered via innerHTML */
  icon?: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  valueLabel?: string;
  onChange: (value: number) => void;
  /** Replaces the default grid container class. Use for non-Inspector layouts. */
  containerClass?: string;
  /** Hides the static value label and shows a tooltip bubble above the thumb while dragging. */
  tooltip?: boolean;
  sliderClass?: string;
  class?: string;
  accentColor?: string;
}> = (props) => {
  const sliderId = createUniqueId();
  const [dragging, setDragging] = createSignal(false);
  let activePointer: {
    pointerId: number;
    startX: number;
    startY: number;
    pointerType: string;
  } | null = null;
  let lastTap: { at: number; x: number; y: number; pointerType: string } | null = null;
  const fraction = () => clamp((props.value - props.min) / (props.max - props.min), 0, 1);
  const defaultFrac = () =>
    clamp((props.defaultValue - props.min) / (props.max - props.min), 0, 1);
  const isBipolar = () => defaultFrac() > 0.01 && defaultFrac() < 0.99;
  const fillLeft = () => Math.min(fraction(), defaultFrac()) * 100;
  const fillWidth = () => Math.abs(fraction() - defaultFrac()) * 100;
  const accent = () => props.accentColor ?? "var(--curve-stroke)";
  const setSliderDragging = (next: boolean) => {
    setDragging(next);
    setIsAdjustmentSliderActive(next);
    setActiveAdjustmentSliderId(next ? sliderId : null);
  };
  const maybeResetToDefault = (
    event: PointerEvent & { currentTarget: HTMLInputElement },
  ) => {
    if (!activePointer || activePointer.pointerId !== event.pointerId) return;
    const moved =
      Math.hypot(
        event.clientX - activePointer.startX,
        event.clientY - activePointer.startY,
      ) > 10;
    const pointerType = activePointer.pointerType;
    activePointer = null;
    if (moved) {
      lastTap = null;
      return;
    }
    const now = performance.now();
    if (
      lastTap &&
      lastTap.pointerType === pointerType &&
      now - lastTap.at <= 300 &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 24
    ) {
      lastTap = null;
      props.onChange(props.defaultValue);
      return;
    }
    lastTap = { at: now, x: event.clientX, y: event.clientY, pointerType };
  };
  onCleanup(() => {
    if (activeAdjustmentSliderId() === sliderId) {
      setIsAdjustmentSliderActive(false);
      setActiveAdjustmentSliderId(null);
    }
  });
  return (
    <div
      data-mobile-slider-active={isAdjustmentSliderActive() ? "true" : undefined}
      data-mobile-slider-current={
        activeAdjustmentSliderId() === sliderId ? "true" : undefined
      }
      class={`${props.containerClass ?? PARAMETER_ROW_CLASS} ${props.class ?? ""} mobile-slider-fade-row transition-opacity duration-150`}
    >
      <Show when={props.icon !== undefined}>
        <span class="flex h-4 w-4 items-center justify-center text-[var(--text-subtle)] [&>svg]:h-4 [&>svg]:w-4" innerHTML={props.icon} />
      </Show>
      <span class="self-center text-[13px] font-medium text-[var(--text-strong)]">
        {props.label}
      </span>
      <Show when={!props.tooltip}>
        <span class="self-center text-right text-xs font-medium tabular-nums text-[var(--text-value)]">
          {props.valueLabel ?? props.value.toFixed(2)}
        </span>
      </Show>
      <div class={`${props.sliderClass} relative col-start-2 col-end-4 h-7 w-full self-center`}>
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 0.01}
          value={props.value}
          aria-label={props.label}
          class="shade-slider absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          style={{ "--slider-accent": accent() }}
          onInput={(event) => {
            const nextValue = event.currentTarget.valueAsNumber;
            if (Number.isNaN(nextValue)) {
              throw new Error("slider input produced NaN");
            }
            props.onChange(nextValue);
          }}
          onPointerDown={(event) => {
            activePointer = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              pointerType: event.pointerType,
            };
            setSliderDragging(true);
            event.stopPropagation();
          }}
          onPointerUp={(event) => {
            setSliderDragging(false);
            void flushDeferredHistorySnapshot();
            void refreshFinalPreview();
            maybeResetToDefault(event);
          }}
          onPointerCancel={() => {
            activePointer = null;
            setSliderDragging(false);
            void flushDeferredHistorySnapshot();
            void refreshFinalPreview();
          }}
          onBlur={() => {
            activePointer = null;
            setSliderDragging(false);
            void flushDeferredHistorySnapshot();
            void refreshFinalPreview();
          }}
        />
        <div class="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--slider-track)]" />
        <div
          class="pointer-events-none absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
          style={{
            left: `${fillLeft()}%`,
            width: `${fillWidth()}%`,
            background: accent(),
            opacity: 0.65,
            transition: dragging() ? "none" : "left 140ms ease-out, width 140ms ease-out",
          }}
        />
        <Show when={isBipolar()}>
          <div
            class="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--slider-notch)]"
            style={{ left: `${defaultFrac() * 100}%` }}
          />
        </Show>
        <div
          class="pointer-events-none absolute top-1/2"
          style={{
            left: `${fraction() * 100}%`,
            transform: `translate(-50%, -50%) scale(${dragging() ? 1.2 : 1})`,
            transition: dragging()
              ? "none"
              : "left 140ms ease-out, transform 100ms ease-out",
          }}
        >
          <Show when={props.tooltip && dragging()}>
            <div class="absolute bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white shadow-sm">
              {props.valueLabel ?? props.value.toFixed(2)}
            </div>
          </Show>
          <div
            class="h-[14px] w-[14px] rounded-full border-2 border-[var(--slider-thumb-border)]"
            style={{
              background: accent(),
              "box-shadow": "var(--slider-thumb-shadow)",
            }}
          />
        </div>
      </div>
    </div>
  );
};
