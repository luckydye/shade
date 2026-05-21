import { onCleanup } from "solid-js";
import { setViewportToneSample } from "./editor-store";

const SMOOTHING_TAU_MS = 90;
const SNAP_THRESHOLD = 0.002;

export function useToneSmoothing(): (target: number | null) => void {
  let frame: number | null = null;
  let smoothed: number | null = null;
  let target: number | null = null;
  let lastTime = 0;

  const stop = () => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  };

  const tick = (time: number) => {
    if (target === null || smoothed === null) {
      stop();
      return;
    }
    const deltaMs = Math.max(1, time - lastTime);
    lastTime = time;
    const blend = 1 - Math.exp(-deltaMs / SMOOTHING_TAU_MS);
    smoothed += (target - smoothed) * blend;
    if (Math.abs(target - smoothed) < SNAP_THRESHOLD) {
      smoothed = target;
    }
    setViewportToneSample(smoothed);
    if (smoothed === target) {
      frame = null;
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  onCleanup(stop);

  return (next: number | null) => {
    target = next;
    if (next === null) {
      stop();
      smoothed = null;
      lastTime = 0;
      setViewportToneSample(null);
      return;
    }
    if (smoothed === null) {
      smoothed = next;
      lastTime = performance.now();
      setViewportToneSample(next);
      return;
    }
    if (frame !== null) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
  };
}
