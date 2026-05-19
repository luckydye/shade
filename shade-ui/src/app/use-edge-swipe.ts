import type { JSX } from "solid-js";

export interface EdgeSwipeOptions {
  /** Maximum distance from the left edge to start the swipe (default: 24) */
  edgeWidth?: number;
  /** Minimum horizontal distance to trigger the swipe (default: 30) */
  minDx?: number;
  /** Maximum vertical deviation allowed (default: 50) */
  maxDy?: number;
  /** Called when a valid edge swipe is detected */
  onSwipe: () => void;
}

export function useEdgeSwipe(
  options: EdgeSwipeOptions,
): JSX.EventHandlerUnion<HTMLDivElement, TouchEvent> {
  const { edgeWidth = 24, minDx = 30, maxDy = 50, onSwipe } = options;

  return (e: TouchEvent) => {
    const touch = e.touches[0];
    if (touch.clientX > edgeWidth) return;

    const startX = touch.clientX;
    const startY = touch.clientY;
    let moved = false;

    function onMove(ev: TouchEvent) {
      if (moved) return;
      const dx = ev.touches[0].clientX - startX;
      const dy = Math.abs(ev.touches[0].clientY - startY);
      if (dx > minDx && dy < maxDy) {
        moved = true;
        onSwipe();
      }
    }

    function onEnd() {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    }

    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { once: true });
  };
}
