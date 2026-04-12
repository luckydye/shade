import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { clamp } from "../store/editor-store";

const SCOPE_MARGIN = 2;
const HUE_RING_WIDTH = 10;
const MAX_CHROMA = 0.55;
const DEFAULT_SCOPE_SIZE = 256;
const DEFAULT_SAMPLE_BUDGET = 160_000;
const SKIN_TONE_HUE = 25;

type ScopeTarget = {
  label: string;
  color: string;
  rgb: readonly [number, number, number];
};

const SCOPE_TARGETS: readonly ScopeTarget[] = [
  { label: "R", color: "#ff5a5a", rgb: [180 / 255, 16 / 255, 16 / 255] },
  { label: "M", color: "#ff5cff", rgb: [180 / 255, 16 / 255, 180 / 255] },
  { label: "B", color: "#5b8dff", rgb: [16 / 255, 16 / 255, 180 / 255] },
  { label: "C", color: "#49d8ff", rgb: [16 / 255, 180 / 255, 180 / 255] },
  { label: "G", color: "#58d36a", rgb: [16 / 255, 180 / 255, 16 / 255] },
  { label: "Y", color: "#ffd84d", rgb: [180 / 255, 180 / 255, 16 / 255] },
];

export interface WheelPoint {
  id: number;
  angle: number;
  radius: number;
  lockAngle?: boolean;
  color?: string;
}

export type VectorScopeProps = {
  activePointId?: number | null;
  allowPointCreation?: boolean;
  allowPointDeletion?: boolean;
  class?: string;
  onChange?: (points: WheelPoint[]) => void;
  onResetPoint?: (id: number) => void;
  points?: readonly WheelPoint[];
  scope?: ImageData | null;
  showTargets?: boolean;
};

function wrapAngle(value: number) {
  return ((value % 360) + 360) % 360;
}

function hueToRgb(degree: number): readonly [number, number, number] {
  const hue = wrapAngle(degree) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  if (hue < 1) return [1, x, 0];
  if (hue < 2) return [x, 1, 0];
  if (hue < 3) return [0, 1, x];
  if (hue < 4) return [0, x, 1];
  if (hue < 5) return [x, 0, 1];
  return [1, 0, x];
}

function buildLUT(points: readonly WheelPoint[]) {
  const lut = new Float64Array(360);
  if (points.length === 0) {
    lut.fill(1);
    return lut;
  }
  if (points.length === 1) {
    lut.fill(points[0].radius);
    return lut;
  }

  const sorted = [...points].sort((left, right) => left.angle - right.angle);
  const count = sorted.length;

  for (let degree = 0; degree < 360; degree += 1) {
    let segmentIndex = count - 1;
    for (let index = 0; index < count; index += 1) {
      const nextIndex = (index + 1) % count;
      const start = sorted[index].angle;
      let end = sorted[nextIndex].angle;
      if (nextIndex === 0) {
        end += 360;
      }
      const sample = degree < start ? degree + 360 : degree;
      if (sample >= start && sample < end) {
        segmentIndex = index;
        break;
      }
    }

    const i0 = segmentIndex;
    const i1 = (i0 + 1) % count;
    const iPrev = (i0 - 1 + count) % count;
    const iNext = (i1 + 1) % count;
    const start = sorted[i0].angle;
    let end = sorted[i1].angle;
    if (end <= start) {
      end += 360;
    }

    let sample = degree;
    if (sample < start) {
      sample += 360;
    }

    const span = end - start;
    const t = span > 0 ? (sample - start) / span : 0;
    let prevSpan = start - sorted[iPrev].angle;
    if (prevSpan <= 0) {
      prevSpan += 360;
    }
    let nextSpan = sorted[iNext].angle - end;
    if (nextSpan <= 0) {
      nextSpan += 360;
    }

    const r0 = sorted[i0].radius;
    const r1 = sorted[i1].radius;
    const rPrev = sorted[iPrev].radius;
    const rNext = sorted[iNext].radius;
    const m0 = ((r1 - rPrev) / (span + prevSpan)) * span;
    const m1 = ((rNext - r0) / (nextSpan + span)) * span;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    lut[degree] = clamp(h00 * r0 + h10 * m0 + h01 * r1 + h11 * m1, 0, 2);
  }

  return lut;
}

function rgbToScopeVector(r: number, g: number, b: number) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const cb = (b - luma) / 1.8556;
  const cr = (r - luma) / 1.5748;
  return {
    x: cb / MAX_CHROMA,
    y: -cr / MAX_CHROMA,
  };
}

function hueToScopeUnitVector(degree: number) {
  const [r, g, b] = hueToRgb(degree);
  const vector = rgbToScopeVector(r, g, b);
  const length = Math.hypot(vector.x, vector.y);
  if (length <= 0) {
    throw new Error("hue scope vector must not be zero");
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function addScopeSample(
  weights: Float32Array,
  reds: Float32Array,
  greens: Float32Array,
  blues: Float32Array,
  size: number,
  x: number,
  y: number,
  weight: number,
  r: number,
  g: number,
  b: number,
) {
  if (weight <= 0) {
    return;
  }
  const index = y * size + x;
  weights[index] += weight;
  reds[index] += r * weight;
  greens[index] += g * weight;
  blues[index] += b * weight;
}

// Usage: const scope = createMemo(() => tile ? buildVectorScope(tile.image) : null);
export function buildVectorScope(
  image: ImageData,
  size = DEFAULT_SCOPE_SIZE,
  sampleBudget = DEFAULT_SAMPLE_BUDGET,
) {
  if (size < 1) {
    throw new Error("vectorscope size must be greater than zero");
  }
  if (sampleBudget < 1) {
    throw new Error("vectorscope sample budget must be greater than zero");
  }

  const scope = new ImageData(size, size);
  if (image.width < 1 || image.height < 1) {
    return scope;
  }

  const weights = new Float32Array(size * size);
  const reds = new Float32Array(size * size);
  const greens = new Float32Array(size * size);
  const blues = new Float32Array(size * size);
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / sampleBudget)));
  const data = image.data;

  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      const offset = (y * image.width + x) * 4;
      const alpha = data[offset + 3] / 255;
      if (alpha <= 0) {
        continue;
      }

      const r = data[offset] / 255;
      const g = data[offset + 1] / 255;
      const b = data[offset + 2] / 255;
      const vector = rgbToScopeVector(r, g, b);
      const px = clamp((vector.x * 0.5 + 0.5) * (size - 1), 0, size - 1);
      const py = clamp((vector.y * 0.5 + 0.5) * (size - 1), 0, size - 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(size - 1, x0 + 1);
      const y1 = Math.min(size - 1, y0 + 1);
      const tx = px - x0;
      const ty = py - y0;

      addScopeSample(
        weights,
        reds,
        greens,
        blues,
        size,
        x0,
        y0,
        (1 - tx) * (1 - ty) * alpha,
        r,
        g,
        b,
      );
      addScopeSample(weights, reds, greens, blues, size, x1, y0, tx * (1 - ty) * alpha, r, g, b);
      addScopeSample(weights, reds, greens, blues, size, x0, y1, (1 - tx) * ty * alpha, r, g, b);
      addScopeSample(weights, reds, greens, blues, size, x1, y1, tx * ty * alpha, r, g, b);
    }
  }

  let peakWeight = 0;
  for (let index = 0; index < weights.length; index += 1) {
    if (weights[index] > peakWeight) {
      peakWeight = weights[index];
    }
  }
  if (peakWeight <= 0) {
    return scope;
  }

  const output = scope.data;
  const peakLog = Math.log1p(peakWeight);

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];
    if (weight <= 0) {
      continue;
    }

    const intensity = Math.sqrt(Math.log1p(weight) / peakLog);
    const invWeight = 1 / weight;
    const pixelIndex = index * 4;
    const r = reds[index] * invWeight;
    const g = greens[index] * invWeight;
    const b = blues[index] * invWeight;

    output[pixelIndex] = Math.round(clamp((r * 0.82 + 0.18) * intensity, 0, 1) * 255);
    output[pixelIndex + 1] = Math.round(clamp((g * 0.82 + 0.18) * intensity, 0, 1) * 255);
    output[pixelIndex + 2] = Math.round(clamp((b * 0.82 + 0.18) * intensity, 0, 1) * 255);
    output[pixelIndex + 3] = Math.round(clamp(intensity * 1.35, 0, 1) * 255);
  }

  return scope;
}

function drawScope(
  canvas: HTMLCanvasElement,
  size: number,
  source: HTMLCanvasElement | null,
  scopeRadius: number,
) {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2d canvas context is unavailable");
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const pixelSize = Math.max(1, Math.round(size * pixelRatio));
  if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
    canvas.width = pixelSize;
    canvas.height = pixelSize;
  }

  context.clearRect(0, 0, pixelSize, pixelSize);
  if (!source) {
    return;
  }

  const scaledRadius = scopeRadius * pixelRatio;
  const diameter = scaledRadius * 2;
  const center = pixelSize / 2;

  context.save();
  context.beginPath();
  context.arc(center, center, scaledRadius, 0, Math.PI * 2);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.drawImage(source, center - scaledRadius, center - scaledRadius, diameter, diameter);
  context.restore();
}

export const VectorScope: Component<VectorScopeProps> = (props) => {
  let rootRef!: HTMLDivElement;
  let svgRef!: SVGSVGElement;
  let canvasRef!: HTMLCanvasElement;
  let lastTapTime = 0;
  let lastTapId = -1;
  let clearDragListeners: (() => void) | null = null;

  const [svgSize, setSvgSize] = createSignal(200);
  const [draggingId, setDraggingId] = createSignal<number | null>(null);
  const [constrained, setConstrained] = createSignal(false);
  const points = () => props.points ?? [];
  const isEditable = () => props.onChange !== undefined;
  const allowPointCreation = () => props.allowPointCreation ?? false;
  const allowPointDeletion = () => props.allowPointDeletion ?? false;
  const center = () => svgSize() / 2;
  const ringInner = () => svgSize() / 2 - SCOPE_MARGIN - HUE_RING_WIDTH;
  const ringOuter = () => svgSize() / 2 - SCOPE_MARGIN;
  const scopeRadius = () => ringInner() - 4;
  const zeroRing = () => scopeRadius() * 0.14;
  const radiusToSvg = (radius: number) =>
    zeroRing() + (radius / 2) * (scopeRadius() - zeroRing());
  const svgToRadius = (distance: number) =>
    clamp(((distance - zeroRing()) / (scopeRadius() - zeroRing())) * 2, 0, 2);
  const lut = createMemo(() => buildLUT(points()));
  const sourceCanvas = createMemo(() => {
    const scope = props.scope;
    if (!scope) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = scope.width;
    canvas.height = scope.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2d canvas context is unavailable");
    }
    context.putImageData(scope, 0, 0);
    return canvas;
  });
  const hueLines = createMemo(() => {
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = [];
    for (let degree = 0; degree < 360; degree += 1) {
      const vector = hueToScopeUnitVector(degree);
      lines.push({
        x1: center() + ringInner() * vector.x,
        y1: center() + ringInner() * vector.y,
        x2: center() + ringOuter() * vector.x,
        y2: center() + ringOuter() * vector.y,
        color: `hsl(${degree}, 100%, 50%)`,
      });
    }
    return lines;
  });
  const targetMarkers = createMemo(() =>
    SCOPE_TARGETS.map((target) => {
      const vector = rgbToScopeVector(target.rgb[0], target.rgb[1], target.rgb[2]);
      return {
        ...target,
        x: center() + vector.x * scopeRadius(),
        y: center() + vector.y * scopeRadius(),
      };
    }),
  );
  const graphPath = createMemo(() => {
    if (points().length === 0) {
      return "";
    }

    const parts: string[] = [];
    for (let degree = 0; degree < 360; degree += 1) {
      const vector = hueToScopeUnitVector(degree);
      const radius = radiusToSvg(lut()[degree]);
      const x = center() + radius * vector.x;
      const y = center() + radius * vector.y;
      parts.push(degree === 0 ? `M${x},${y}` : `L${x},${y}`);
    }
    parts.push("Z");
    return parts.join(" ");
  });

  onMount(() => {
    const updateSize = () => {
      setSvgSize(Math.max(1, Math.round(rootRef.clientWidth)));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(rootRef);
    onCleanup(() => {
      observer.disconnect();
      clearDragListeners?.();
    });
  });

  createEffect(() => {
    drawScope(canvasRef, svgSize(), sourceCanvas(), scopeRadius());
  });

  const svgPolar = (event: { clientX: number; clientY: number }) => {
    const point = svgRef.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = svgRef.getScreenCTM();
    if (!ctm) {
      throw new Error("missing SVG screen transform");
    }
    const local = point.matrixTransform(ctm.inverse());
    const dx = local.x - center();
    const dy = local.y - center();
    const length = Math.hypot(dx, dy);
    let bestAngle = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    if (length > 0) {
      const nx = dx / length;
      const ny = dy / length;
      for (let degree = 0; degree < 360; degree += 1) {
        const vector = hueToScopeUnitVector(degree);
        const distance = (vector.x - nx) ** 2 + (vector.y - ny) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestAngle = degree;
        }
      }
    }
    return {
      angle: bestAngle,
      radius: svgToRadius(length),
    };
  };

  const finishDrag = () => {
    clearDragListeners?.();
    clearDragListeners = null;
    setDraggingId(null);
    setConstrained(false);
  };

  const updateDragging = (clientX: number, clientY: number) => {
    const id = draggingId();
    if (id === null || !props.onChange) {
      return;
    }
    const nextPolar = svgPolar({ clientX, clientY });
    props.onChange(
      points().map((point) =>
        point.id === id
          ? {
              ...point,
              angle: point.lockAngle || constrained() ? point.angle : nextPolar.angle,
              radius: nextPolar.radius,
            }
          : point,
      ),
    );
  };

  const trackPointerDrag = (pointerId: number) => {
    clearDragListeners?.();
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      setConstrained(event.shiftKey);
      updateDragging(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      finishDrag();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      finishDrag();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    clearDragListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  };

  const startNewPoint = (clientX: number, clientY: number) => {
    if (!props.onChange) {
      throw new Error("point creation requires an onChange handler");
    }
    const maxId = points().reduce((currentMax, point) => Math.max(currentMax, point.id), 0);
    const nextId = maxId + 1;
    const nextPolar = svgPolar({ clientX, clientY });
    props.onChange([...points(), { id: nextId, angle: nextPolar.angle, radius: nextPolar.radius }]);
    setDraggingId(nextId);
  };

  const startExistingPoint = (id: number) => {
    if (!props.onChange) {
      throw new Error("point editing requires an onChange handler");
    }
    const now = Date.now();
    if (now - lastTapTime < 300 && lastTapId === id) {
      lastTapTime = 0;
      if (props.onResetPoint) {
        props.onResetPoint(id);
        finishDrag();
        return false;
      }
      if (!allowPointDeletion()) {
        finishDrag();
        return false;
      }
      props.onChange(points().filter((point) => point.id !== id));
      finishDrag();
      return false;
    }
    lastTapTime = now;
    lastTapId = id;
    setDraggingId(id);
    return true;
  };

  return (
    <div
      ref={rootRef!}
      class={`relative aspect-square w-full overflow-hidden rounded-full bg-transparent ${
        props.class ?? ""
      }`}
    >
      <canvas ref={canvasRef!} class="absolute inset-0 h-full w-full" />
      <svg
        ref={svgRef!}
        viewBox={`0 0 ${svgSize()} ${svgSize()}`}
        class="absolute inset-0 h-full w-full"
        style={{
          cursor: draggingId() !== null ? "grabbing" : isEditable() ? "crosshair" : "default",
          "touch-action": "none",
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType === "touch" || !allowPointCreation()) {
            return;
          }
          if (event.target !== svgRef) {
            return;
          }
          event.preventDefault();
          startNewPoint(event.clientX, event.clientY);
          trackPointerDrag(event.pointerId);
        }}
      >
        {hueLines().map((line) => (
          <line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke={line.color}
            stroke-width="2.5"
            opacity="0.5"
            pointer-events="none"
          />
        ))}
        <circle
          cx={center()}
          cy={center()}
          r={scopeRadius()}
          fill="none"
          stroke="rgba(255,255,255,0.14)"
          stroke-width="1.1"
          pointer-events="none"
        />
        <line
          x1={center() - scopeRadius()}
          y1={center()}
          x2={center() + scopeRadius()}
          y2={center()}
          stroke="rgba(255,255,255,0.12)"
          stroke-width="1"
          pointer-events="none"
        />
        <line
          x1={center()}
          y1={center() - scopeRadius()}
          x2={center()}
          y2={center() + scopeRadius()}
          stroke="rgba(255,255,255,0.12)"
          stroke-width="1"
          pointer-events="none"
        />
        <line
          x1={center()}
          y1={center()}
          x2={center() + scopeRadius() * hueToScopeUnitVector(SKIN_TONE_HUE).x}
          y2={center() + scopeRadius() * hueToScopeUnitVector(SKIN_TONE_HUE).y}
          stroke="rgba(255,160,160,0.55)"
          stroke-width="1.25"
          stroke-dasharray="5 4"
          pointer-events="none"
        />
        <circle
          cx={center()}
          cy={center()}
          r={zeroRing()}
          fill="none"
          stroke="rgba(255,255,255,0.18)"
          stroke-width="1"
          pointer-events="none"
        />
        {graphPath() && (
          <path
            d={graphPath()}
            fill="none"
            stroke="rgba(255,255,255,0.72)"
            stroke-width="1.5"
            pointer-events="none"
          />
        )}
        <circle
          cx={center()}
          cy={center()}
          r="2.5"
          fill="rgba(255,255,255,0.6)"
          pointer-events="none"
        />
        {(props.showTargets ?? true) &&
          targetMarkers().map((target) => (
            <>
              <rect
                x={target.x - 5}
                y={target.y - 5}
                width="10"
                height="10"
                fill="none"
                stroke={target.color}
                stroke-width="1"
                opacity="0.5"
                pointer-events="none"
              />
              <text
                x={target.x}
                y={target.y - 9}
                fill={target.color}
                font-size="10"
                font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
                text-anchor="middle"
                opacity="0.5"
                pointer-events="none"
              >
                {target.label}
              </text>
            </>
          ))}
        {(() => {
          const id = draggingId();
          if (id === null) {
            return null;
          }
          const point = points().find((candidate) => candidate.id === id);
          if (!point || (!point.lockAngle && !constrained())) {
            return null;
          }
          const vector = hueToScopeUnitVector(point.angle);
          return (
            <line
              x1={center() + zeroRing() * vector.x}
              y1={center() + zeroRing() * vector.y}
              x2={center() + scopeRadius() * vector.x}
              y2={center() + scopeRadius() * vector.y}
              stroke="rgba(255,255,255,0.45)"
              stroke-width="1"
              stroke-dasharray="3 3"
              pointer-events="none"
            />
          );
        })()}
        {points().map((point) => {
          const vector = hueToScopeUnitVector(point.angle);
          const svgRadius = radiusToSvg(point.radius);
          const x = center() + svgRadius * vector.x;
          const y = center() + svgRadius * vector.y;
          const isActive = props.activePointId === point.id;
          const pointColor = point.color ?? `hsl(${point.angle}, 80%, 60%)`;
          return (
            <>
              <circle
                cx={x}
                cy={y}
                r="14"
                fill="transparent"
                onPointerDown={(event) => {
                  if (event.button !== 0 || event.pointerType === "touch" || !isEditable()) {
                    return;
                  }
                  event.stopPropagation();
                  event.preventDefault();
                  if (startExistingPoint(point.id)) {
                    trackPointerDrag(event.pointerId);
                  }
                }}
                style={{ cursor: isEditable() ? "grab" : "default" }}
              />
              <circle
                cx={x}
                cy={y}
                r={isActive ? "6.5" : "5"}
                fill={pointColor}
                stroke="rgba(255,255,255,0.95)"
                stroke-width={isActive ? "2" : "1.5"}
                pointer-events="none"
              />
            </>
          );
        })}
      </svg>
    </div>
  );
};

export const ColorWheel = VectorScope;
