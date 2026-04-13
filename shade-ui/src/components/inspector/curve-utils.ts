export const CURVE_SAMPLE_INDICES = [64, 128, 192] as const;
export const CURVE_MIN_X = 0;
export const CURVE_MAX_X = 255;
export const IDENTITY_LUT = Array.from({ length: 256 }, (_, idx) => idx / 255);
export const LS_CURVE_IDENTITY = Array.from({ length: 256 }, () => 1.0);
export const HISTOGRAM_SCALE_CLIP_PERCENTILE = 0.95;
export const HISTOGRAM_SCALE_CLIP_MIN_BINS = 8;
export const HISTOGRAM_CLIPPING_EPSILON = 1 / 255;
export const DEFAULT_HISTOGRAM_SAMPLE_BUDGET = 160_000;

export const TONE_THRESHOLD_BOUNDARIES = [
  { key: "shadows", label: "Shadows", value: 0.25 },
  { key: "midtones", label: "Midtones", value: 0.5 },
  { key: "highlights", label: "Highlights", value: 0.75 },
] as const;

export interface ControlPoint {
  x: number;
  y: number;
}

export interface EditableControlPoint extends ControlPoint {
  id: number;
}

export interface LuminanceHistogram {
  bins: number[];
  shadowsClipping: boolean;
  highlightsClipping: boolean;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// --- Point normalization ---

function normalizePointGeneric(point: ControlPoint, maxY: number): ControlPoint {
  return {
    x: clamp(Math.round(point.x), CURVE_MIN_X, CURVE_MAX_X),
    y: clamp(point.y, 0, maxY),
  };
}

function normalizeInteriorPointGeneric(point: ControlPoint, maxY: number): ControlPoint {
  return {
    x: clamp(Math.round(point.x), CURVE_MIN_X + 1, CURVE_MAX_X - 1),
    y: clamp(point.y, 0, maxY),
  };
}

function normalizePointsGeneric(
  points: readonly ControlPoint[],
  normalize: (p: ControlPoint) => ControlPoint,
  leftDefaultY: number,
): ControlPoint[] {
  const normalized = [...points]
    .map(normalize)
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
  if (normalized[0]?.x !== CURVE_MIN_X) {
    normalized.unshift({ x: CURVE_MIN_X, y: leftDefaultY });
  }
  if (normalized[normalized.length - 1]?.x !== CURVE_MAX_X) {
    normalized.push({ x: CURVE_MAX_X, y: 1 });
  }
  return normalized;
}

export function normalizePoint(point: ControlPoint): ControlPoint {
  return normalizePointGeneric(point, 1);
}

export function normalizeLsPoint(point: ControlPoint): ControlPoint {
  return normalizePointGeneric(point, 2);
}

export function normalizeInteriorPoint(point: ControlPoint): ControlPoint {
  return normalizeInteriorPointGeneric(point, 1);
}

export function normalizeLsInteriorPoint(point: ControlPoint): ControlPoint {
  return normalizeInteriorPointGeneric(point, 2);
}

export function normalizePoints(points: readonly ControlPoint[]): ControlPoint[] {
  return normalizePointsGeneric(points, normalizePoint, 0);
}

export function normalizeLsPoints(points: readonly ControlPoint[]): ControlPoint[] {
  return normalizePointsGeneric(points, normalizeLsPoint, 1);
}

export function isEndpointPoint(point: ControlPoint) {
  return point.x === CURVE_MIN_X || point.x === CURVE_MAX_X;
}

// --- LUT builders ---

function buildLutGeneric(
  points: readonly ControlPoint[],
  normalize: (pts: readonly ControlPoint[]) => ControlPoint[],
  maxY: number,
  errorPrefix: string,
): number[] {
  const anchors = normalize(points);
  if (anchors.length < 2) {
    throw new Error(`${errorPrefix} requires explicit left and right endpoint clamps`);
  }
  if (anchors[0]?.x !== CURVE_MIN_X) {
    throw new Error(`${errorPrefix} must include a left endpoint clamp at x=0`);
  }
  if (anchors[anchors.length - 1]?.x !== CURVE_MAX_X) {
    throw new Error(`${errorPrefix} must include a right endpoint clamp at x=255`);
  }
  const lut = new Array<number>(256);
  const delta = new Array<number>(anchors.length - 1);
  const tangent = new Array<number>(anchors.length);
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const span = anchors[i + 1].x - anchors[i].x;
    if (span <= 0) {
      throw new Error(`${errorPrefix} anchors must be strictly increasing`);
    }
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
        h00 * start.y +
          h10 * span * tangent[seg] +
          h01 * end.y +
          h11 * span * tangent[seg + 1],
        0,
        maxY,
      );
    }
  }
  return lut;
}

export function buildLutFromPoints(points: readonly ControlPoint[]): number[] {
  return buildLutGeneric(points, normalizePoints, 1, "curve");
}

export function buildLsCurveLutFromPoints(points: readonly ControlPoint[]): number[] {
  return buildLutGeneric(points, normalizeLsPoints, 2, "ls curve");
}

// --- SVG path helpers ---

function buildCurvePath(lut: readonly number[], maxY: number) {
  return lut
    .map((value, idx) => {
      const command = idx === 0 ? "M" : "L";
      const x = (idx / 255) * 100;
      const y = (1 - clamp(value, 0, maxY) / maxY) * 100;
      return `${command} ${x} ${y}`;
    })
    .join(" ");
}

export function curvePath(lut: readonly number[]) {
  return buildCurvePath(lut, 1);
}

export function lsCurvePath(lut: readonly number[]) {
  return buildCurvePath(lut, 2);
}

export function buildLuminanceHistogram(
  frame: ImageData,
  binCount = 64,
  sampleBudget = DEFAULT_HISTOGRAM_SAMPLE_BUDGET,
): LuminanceHistogram {
  if (binCount <= 0) {
    throw new Error("histogram bin count must be greater than zero");
  }
  if (sampleBudget <= 0) {
    throw new Error("histogram sample budget must be greater than zero");
  }
  const bins = new Array<number>(binCount).fill(0);
  const { data } = frame;
  const channelScale = data instanceof Uint8ClampedArray ? 255 : 1;
  const sampleStep = Math.max(
    1,
    Math.ceil(Math.sqrt((frame.width * frame.height) / sampleBudget)),
  );
  let shadowsClipping = false;
  let highlightsClipping = false;
  for (let y = 0; y < frame.height; y += sampleStep) {
    for (let x = 0; x < frame.width; x += sampleStep) {
      const idx = (y * frame.width + x) * 4;
      const alpha = data[idx + 3] / channelScale;
      if (alpha <= 0) {
        continue;
      }
      const lum = clamp(
        (data[idx] * 0.2126 + data[idx + 1] * 0.7152 + data[idx + 2] * 0.0722) / channelScale,
        0,
        1,
      );
      const bin = clamp(Math.floor(lum * (binCount - 1)), 0, binCount - 1);
      bins[bin] += 1;
      shadowsClipping ||= lum <= HISTOGRAM_CLIPPING_EPSILON;
      highlightsClipping ||= lum >= 1 - HISTOGRAM_CLIPPING_EPSILON;
    }
  }
  const peak = Math.max(...bins, 0);
  if (peak === 0) {
    return {
      bins,
      shadowsClipping: false,
      highlightsClipping: false,
    };
  }
  const nonZeroBins = bins.filter((value) => value > 0).sort((left, right) => left - right);
  const clipPeak =
    nonZeroBins.length < HISTOGRAM_SCALE_CLIP_MIN_BINS
      ? peak
      : nonZeroBins[Math.floor((nonZeroBins.length - 1) * HISTOGRAM_SCALE_CLIP_PERCENTILE)];
  return {
    bins: bins.map((value) => Math.min(value / clipPeak, 1)),
    shadowsClipping,
    highlightsClipping,
  };
}

export function histogramPath(bins: readonly number[]) {
  if (bins.length === 0) {
    return "";
  }
  const step = bins.length === 1 ? 0 : 100 / (bins.length - 1);
  const top = bins
    .map((value, idx) => `L ${idx * step} ${(1 - value) * 100}`)
    .join(" ");
  return `M 0 100 ${top} L 100 100 Z`;
}

export function remapPath(path: string, width: number, height: number, padding: number) {
  if (!path) {
    return "";
  }
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  return path.replace(
    /([ML])\s+([0-9.]+)\s+([0-9.]+)/g,
    (_, command: string, x: string, y: string) => {
      const nextX = padding + (parseFloat(x) / 100) * innerWidth;
      const nextY = padding + (parseFloat(y) / 100) * innerHeight;
      return `${command} ${nextX} ${nextY}`;
    },
  );
}

export function sampleCurveValue(lut: readonly number[], x: number) {
  const clampedX = clamp(x, 0, 255);
  const lower = Math.floor(clampedX);
  const upper = Math.ceil(clampedX);
  const start = clamp(lut[lower] ?? 0, 0, 1);
  const end = clamp(lut[upper] ?? start, 0, 1);
  return start + (end - start) * (clampedX - lower);
}

export function valueLabel(value: number, scale = 100) {
  return `${Math.round(value * scale)}`;
}
