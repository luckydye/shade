import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

export interface WheelPoint {
  id: number;
  angle: number; // degrees 0–360
  radius: number; // 0 = center, 1 = neutral, >1 = boosted
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// Wrap angle to [0, 360)
function wrapAngle(a: number) {
  return ((a % 360) + 360) % 360;
}

// Cyclic Catmull-Rom interpolation to build a 360-entry LUT from control points
function buildLUT(points: WheelPoint[]): Float64Array {
  const lut = new Float64Array(360);
  if (points.length === 0) {
    lut.fill(1.0);
    return lut;
  }
  if (points.length === 1) {
    lut.fill(points[0].radius);
    return lut;
  }

  const sorted = [...points].sort((a, b) => a.angle - b.angle);
  const n = sorted.length;

  for (let deg = 0; deg < 360; deg++) {
    // Find which segment this degree falls in
    let segIdx = n - 1;
    for (let i = 0; i < n; i++) {
      const nextI = (i + 1) % n;
      const a0 = sorted[i].angle;
      let a1 = sorted[nextI].angle;
      if (nextI === 0) a1 += 360; // wrap
      const d = deg < a0 ? deg + 360 : deg;
      if (d >= a0 && d < a1) {
        segIdx = i;
        break;
      }
    }

    const i0 = segIdx;
    const i1 = (i0 + 1) % n;
    const iPrev = (i0 - 1 + n) % n;
    const iNext = (i1 + 1) % n;

    const a0 = sorted[i0].angle;
    let a1 = sorted[i1].angle;
    if (a1 <= a0) a1 += 360;

    let d = deg;
    if (d < a0) d += 360;

    const span = a1 - a0;
    const t = span > 0 ? (d - a0) / span : 0;

    // Tangent computation with cyclic wrapping
    const aPrev = sorted[iPrev].angle;
    const aNext = sorted[iNext].angle;
    let spanPrev = a0 - aPrev;
    if (spanPrev <= 0) spanPrev += 360;
    let spanNext = aNext - a1;
    if (spanNext <= 0) spanNext += 360;

    const r0 = sorted[i0].radius;
    const r1 = sorted[i1].radius;
    const rPrev = sorted[iPrev].radius;
    const rNext = sorted[iNext].radius;

    // Catmull-Rom tangents scaled by segment span
    const m0 = ((r1 - rPrev) / (span + spanPrev)) * span;
    const m1 = ((rNext - r0) / (spanNext + span)) * span;

    // Hermite basis
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    lut[deg] = clamp(h00 * r0 + h10 * m0 + h01 * r1 + h11 * m1, 0, 2);
  }

  return lut;
}

const DEG2RAD = Math.PI / 180;

// Build a 360-bin hue histogram from RGBA ImageData.
// Each bin counts pixels whose dominant hue falls on that degree.
// Low-saturation pixels (near grey) are skipped.
export function buildHueHistogram(image: ImageData): Float64Array {
  const bins = new Float64Array(360);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const a = data[i + 3] / 255;
    if (a <= 0) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta < 0.05 || max < 0.01) continue; // skip near-grey / near-black
    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
    bins[Math.round(hue) % 360] += a;
  }
  return bins;
}

export const ColorWheel: Component<{
  points: WheelPoint[];
  onChange: (points: WheelPoint[]) => void;
  hueHistogram?: Float64Array;
}> = (props) => {
  let svgRef!: SVGSVGElement;
  let nextId = Math.max(0, ...props.points.map((p) => p.id)) + 1;
  let lastTapTime = 0;
  let lastTapId = -1;
  let activeTouchId: number | null = null;
  let clearDragListeners: (() => void) | null = null;

  const [svgSize, setSvgSize] = createSignal(200);
  const [draggingId, setDraggingId] = createSignal<number | null>(null);

  const margin = 24;
  const ringWidth = 10;
  const cx = () => svgSize() / 2;
  const cy = () => svgSize() / 2;
  const ringInner = () => svgSize() / 2 - margin - ringWidth;
  const ringOuter = () => svgSize() / 2 - margin;
  // Inner ring = radius 0, outer edge (ringInner) = radius 2
  const zeroRing = () => (ringInner() - 4) * 0.2;
  const radiusToSvg = (r: number) => zeroRing() + (r / 2) * (ringInner() - 4 - zeroRing());
  const svgToRadius = (dist: number) => clamp(((dist - zeroRing()) / (ringInner() - 4 - zeroRing())) * 2, 0, 2);

  const lut = createMemo(() => buildLUT(props.points));

  // Graph path from LUT
  const graphPath = createMemo(() => {
    const l = lut();
    const cxv = cx();
    const cyv = cy();
    const parts: string[] = [];
    for (let deg = 0; deg < 360; deg++) {
      const rad = deg * DEG2RAD;
      const r = radiusToSvg(l[deg]);
      const x = cxv + r * Math.cos(rad);
      const y = cyv - r * Math.sin(rad);
      parts.push(deg === 0 ? `M${x},${y}` : `L${x},${y}`);
    }
    parts.push("Z");
    return parts.join(" ");
  });

  // Hue ring segments
  const hueLines = createMemo(() => {
    const ri = ringInner();
    const ro = ringOuter();
    const cxv = cx();
    const cyv = cy();
    const lines: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
    for (let deg = 0; deg < 360; deg++) {
      const rad = deg * DEG2RAD;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      lines.push({
        x1: cxv + ri * cos,
        y1: cyv - ri * sin,
        x2: cxv + ro * cos,
        y2: cyv - ro * sin,
        color: `hsl(${deg}, 100%, 50%)`,
      });
    }
    return lines;
  });

  // Histogram bars as radial lines from zero ring outward
  const histogramPath = createMemo(() => {
    const h = props.hueHistogram;
    if (!h || h.length !== 360) return "";
    let logPeak = 0;
    for (let i = 0; i < 360; i++) {
      const v = h[i] > 0 ? Math.log1p(h[i]) : 0;
      if (v > logPeak) logPeak = v;
    }
    if (logPeak <= 0) return "";
    const r0 = zeroRing();
    const maxR = ringInner() - 2 - r0;
    const cxv = cx();
    const cyv = cy();
    const parts: string[] = [];
    for (let deg = 0; deg < 360; deg++) {
      if (h[deg] <= 0) continue;
      const barLen = (Math.log1p(h[deg]) / logPeak) * maxR;
      if (barLen < 0.5) continue;
      const rad = deg * DEG2RAD;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      parts.push(`M${cxv + r0 * cos},${cyv - r0 * sin} L${cxv + (r0 + barLen) * cos},${cyv - (r0 + barLen) * sin}`);
    }
    return parts.join(" ");
  });

  // Neutral circle (radius=1.0) and zero ring (radius=0) in SVG coords
  const neutralR = () => radiusToSvg(1);
  const zeroR = () => zeroRing();

  onMount(() => {
    const update = () => {
      const s = Math.max(1, Math.round(svgRef.clientWidth));
      setSvgSize(s);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(svgRef);
    onCleanup(() => {
      obs.disconnect();
      clearDragListeners?.();
    });
  });

  // --- Coordinate conversion ---
  const svgPolar = (event: { clientX: number; clientY: number }) => {
    const point = svgRef.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = svgRef.getScreenCTM();
    if (!ctm) throw new Error("missing SVG screen transform");
    const local = point.matrixTransform(ctm.inverse());
    const dx = local.x - cx();
    const dy = -(local.y - cy());
    const angle = wrapAngle((Math.atan2(dy, dx) * 180) / Math.PI);
    const radius = svgToRadius(Math.hypot(dx, dy));
    return { angle, radius };
  };

  // --- Drag logic ---
  const [constrained, setConstrained] = createSignal(false);

  const updateDragging = (clientX: number, clientY: number) => {
    const id = draggingId();
    if (id === null) return;
    const { angle, radius } = svgPolar({ clientX, clientY });
    const next = props.points.map((p) =>
      p.id === id ? { ...p, angle: constrained() ? p.angle : angle, radius } : p,
    );
    props.onChange(next);
  };

  const finishDrag = () => {
    clearDragListeners?.();
    clearDragListeners = null;
    activeTouchId = null;
    setDraggingId(null);
    setConstrained(false);
  };

  const trackPointerDrag = (pointerId: number) => {
    clearDragListeners?.();
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      setConstrained(e.shiftKey);
      updateDragging(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      finishDrag();
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      finishDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    clearDragListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  const findTouch = (touches: TouchList, identifier: number) => {
    for (let i = 0; i < touches.length; i++) {
      const t = touches.item(i);
      if (t?.identifier === identifier) return t;
    }
    return null;
  };

  const trackTouchDrag = (identifier: number) => {
    clearDragListeners?.();
    const onMove = (e: TouchEvent) => {
      const t = findTouch(e.touches, identifier);
      if (!t) return;
      e.preventDefault();
      updateDragging(t.clientX, t.clientY);
    };
    const onEnd = (e: TouchEvent) => {
      const t = findTouch(e.changedTouches, identifier);
      if (!t) return;
      e.preventDefault();
      finishDrag();
    };
    const onCancel = (e: TouchEvent) => {
      const t = findTouch(e.changedTouches, identifier);
      if (!t) return;
      finishDrag();
    };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onCancel);
    clearDragListeners = () => {
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onCancel);
    };
  };

  const startNewPoint = (clientX: number, clientY: number) => {
    const { angle, radius } = svgPolar({ clientX, clientY });
    const maxExisting = props.points.reduce((m, p) => Math.max(m, p.id), nextId);
    nextId = maxExisting + 1;
    const id = nextId++;
    const next = [...props.points, { id, angle, radius }];
    props.onChange(next);
    setDraggingId(id);
  };

  const startExistingPoint = (id: number): boolean => {
    const now = Date.now();
    if (now - lastTapTime < 300 && lastTapId === id) {
      // Double-tap → delete
      lastTapTime = 0;
      props.onChange(props.points.filter((p) => p.id !== id));
      finishDrag();
      return false;
    }
    lastTapTime = now;
    lastTapId = id;
    setDraggingId(id);
    return true;
  };

  return (
    <svg
      ref={svgRef!}
      viewBox={`0 0 ${svgSize()} ${svgSize()}`}
      class="w-full aspect-square"
      style={{
        cursor: draggingId() !== null ? "grabbing" : "crosshair",
        "touch-action": "none",
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (e.pointerType === "touch") return;
        if (e.target !== svgRef) return;
        e.preventDefault();
        startNewPoint(e.clientX, e.clientY);
        trackPointerDrag(e.pointerId);
      }}
      onTouchStart={(e) => {
        if (e.touches.length !== 1) {
          finishDrag();
          return;
        }
        const touch = e.touches.item(0);
        if (!touch) throw new Error("wheel touch requires an active touch point");
        activeTouchId = touch.identifier;
        if (e.target === svgRef) {
          e.preventDefault();
          startNewPoint(touch.clientX, touch.clientY);
          trackTouchDrag(touch.identifier);
        }
      }}
    >
      {/* Hue ring */}
      {hueLines().map((l) => (
        <line
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke={l.color}
          stroke-width="2.5"
          pointer-events="none"
        />
      ))}

      {/* Hue histogram background */}
      {histogramPath() && (
        <path
          d={histogramPath()}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          stroke-width="1.5"
          pointer-events="none"
        />
      )}

      {/* Zero ring (radius = 0) */}
      <circle
        cx={cx()}
        cy={cy()}
        r={zeroR()}
        fill="none"
        stroke="var(--text-muted, #666)"
        stroke-width="1"
        opacity="0.3"
        pointer-events="none"
      />

      {/* Neutral circle (radius = 1.0 baseline) */}
      <circle
        cx={cx()}
        cy={cy()}
        r={neutralR()}
        fill="none"
        stroke="var(--text-muted, #666)"
        stroke-width="1"
        stroke-dasharray="4 3"
        opacity="0.5"
        pointer-events="none"
      />

      {/* Graph path */}
      <path
        d={graphPath()}
        fill="rgba(255,255,255,0.06)"
        stroke="var(--text-strong, #fff)"
        stroke-width="1.5"
        pointer-events="none"
      />

      {/* Radial constraint indicator */}
      {(() => {
        const id = draggingId();
        if (id === null || !constrained()) return null;
        const pt = props.points.find((p) => p.id === id);
        if (!pt) return null;
        const rad = pt.angle * DEG2RAD;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const r0 = zeroRing();
        const r1 = ringInner() - 2;
        return (
          <line
            x1={cx() + r0 * cos}
            y1={cy() - r0 * sin}
            x2={cx() + r1 * cos}
            y2={cy() - r1 * sin}
            stroke="var(--text-strong, #fff)"
            stroke-width="1"
            stroke-dasharray="3 3"
            opacity="0.4"
            pointer-events="none"
          />
        );
      })()}

      {/* Control points */}
      {props.points.map((pt) => {
        const rad = () => pt.angle * DEG2RAD;
        const svgR = () => radiusToSvg(pt.radius);
        const px = () => cx() + svgR() * Math.cos(rad());
        const py = () => cy() - svgR() * Math.sin(rad());
        return (
          <>
            {/* Hit area */}
            <circle
              cx={px()}
              cy={py()}
              r="14"
              fill="transparent"
              stroke="none"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (e.pointerType === "touch") return;
                e.stopPropagation();
                e.preventDefault();
                if (startExistingPoint(pt.id)) {
                  trackPointerDrag(e.pointerId);
                }
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
                const touch = e.touches.item(0);
                if (!touch) throw new Error("wheel touch requires an active touch point");
                activeTouchId = touch.identifier;
                e.preventDefault();
                if (startExistingPoint(pt.id)) {
                  trackTouchDrag(touch.identifier);
                }
              }}
              style={{ cursor: "grab" }}
            />
            {/* Visible dot */}
            <circle
              cx={px()}
              cy={py()}
              r="5"
              fill={`hsl(${pt.angle}, 80%, 60%)`}
              stroke="var(--text-strong, #fff)"
              stroke-width="1.5"
              pointer-events="none"
            />
          </>
        );
      })}
    </svg>
  );
};
