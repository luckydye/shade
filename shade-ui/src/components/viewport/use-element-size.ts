import { type Accessor, createEffect, onCleanup } from "solid-js";

const DEBOUNCE_MS = 60;

export function useElementSize(
  ref: Accessor<HTMLElement | null>,
  onChange: (width: number, height: number) => void,
) {
  createEffect(() => {
    const element = ref();
    if (!element) return;

    let frame = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      frame = 0;
      timeout = null;
      onChange(element.clientWidth, element.clientHeight);
    };

    flush();

    const observer = new ResizeObserver(() => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (timeout !== null) clearTimeout(timeout);
        timeout = setTimeout(flush, DEBOUNCE_MS);
      });
    });
    observer.observe(element);

    onCleanup(() => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      if (timeout !== null) clearTimeout(timeout);
    });
  });
}
