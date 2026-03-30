import type { Accessor, Component } from "solid-js";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { backdropTile } from "../../viewport/preview";
import { isAdjustmentSliderActive, state } from "../../store/editor";
import { curveSvg } from "./inspector-icons";
import {
  buildLsCurveLutFromPoints,
  buildLuminanceHistogram,
  clamp,
  histogramPath,
  isEndpointPoint,
  lsCurvePath,
  normalizeLsInteriorPoint,
  normalizeLsPoints,
  remapPath,
  type ControlPoint,
  type EditableControlPoint,
  TONE_THRESHOLD_BOUNDARIES,
} from "./curve-utils";

type LsCurveEditorProps = {
  lsCurvePointCache: Accessor<Map<number, ControlPoint[]>>;
  defaultLsCurvePoints: Accessor<ControlPoint[]>;
  onApplyLsCurve: (points: readonly ControlPoint[]) => Promise<unknown>;
  parameterRowClass: string;
};

export const LsCurveEditor: Component<LsCurveEditorProps> = (props) => {
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
          props.lsCurvePointCache().get(layerIdx) ??
          layer.adjustments?.ls_curve?.control_points ??
          props.defaultLsCurvePoints();
        nextId = 0;
        setPts(
          normalizeLsPoints(
            points.length === 0 ? props.defaultLsCurvePoints() : points,
          ).map((point) => ({
            ...point,
            id: nextId++,
          })),
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
    if (!ctm) {
      throw new Error("missing SVG screen transform");
    }
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
      .map((point) => (point.id === id ? { ...point, x, y } : point))
      .sort((left, right) => left.x - right.x);
    setPts(next);
    void props.onApplyLsCurve(next);
  };

  const finishDraggingPoint = () => {
    clearCurveDragListeners?.();
    clearCurveDragListeners = null;
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
    const next = [...pts(), { x, y, id }].sort((left, right) => left.x - right.x);
    setPts(next);
    void props.onApplyLsCurve(next);
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
          .map((candidate) => (candidate.id === id ? { ...candidate, y: 1 } : candidate))
          .sort((left, right) => left.x - right.x);
        setPts(next);
        void props.onApplyLsCurve(next);
      } else {
        const next = pts().filter((candidate) => candidate.id !== id);
        setPts(next);
        void props.onApplyLsCurve(next);
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
      class={`${props.parameterRowClass} mobile-slider-fade gap-y-1.5 transition-opacity duration-150`}
    >
      <span
        class="flex h-4 w-4 items-center justify-center text-[var(--text-subtle)] [&>svg]:h-4 [&>svg]:w-4"
        innerHTML={curveSvg}
      />
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
          onPointerDown={(event) => {
            if (event.button !== 0 || event.pointerType === "touch" || event.target !== svgRef) {
              return;
            }
            event.preventDefault();
            startNewPointDrag(event.clientX, event.clientY);
            trackPointerDrag(event.pointerId);
          }}
          onPointerLeave={() => {
            setHoveredId(null);
          }}
          onTouchStart={(event) => {
            if (event.touches.length !== 1) {
              finishDraggingPoint();
              return;
            }
            const touch = event.touches.item(0);
            if (!touch) {
              throw new Error("curve touch interaction requires an active touch point");
            }
            if (event.target === svgRef) {
              event.preventDefault();
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
          {pts().map((point) => (
            <>
              <circle
                cx={chartX(point.x)}
                cy={chartY(point.y)}
                r="7"
                fill="none"
                stroke="var(--curve-stroke)"
                stroke-width="1.5"
                opacity={hoveredId() === point.id ? "0.75" : "0"}
                pointer-events="none"
              />
              <circle
                cx={chartX(point.x)}
                cy={chartY(point.y)}
                r="14"
                fill="transparent"
                stroke="none"
                style={{
                  cursor: draggingId() === point.id ? "grabbing" : "grab",
                }}
                onTouchStart={(event) => {
                  event.stopPropagation();
                  if (event.touches.length !== 1) {
                    finishDraggingPoint();
                    return;
                  }
                  const touch = event.touches.item(0);
                  if (!touch) {
                    throw new Error(
                      "curve point touch interaction requires an active touch point",
                    );
                  }
                  event.preventDefault();
                  if (!startExistingPointDrag(point.id)) {
                    return;
                  }
                  trackTouchDrag(touch.identifier);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || event.pointerType === "touch") {
                    return;
                  }
                  event.stopPropagation();
                  if (!startExistingPointDrag(point.id)) {
                    return;
                  }
                  trackPointerDrag(event.pointerId);
                }}
              />
              <circle
                cx={chartX(point.x)}
                cy={chartY(point.y)}
                r="3.5"
                fill={isEndpointPoint(point) ? "var(--curve-endpoint)" : "var(--curve-point)"}
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
