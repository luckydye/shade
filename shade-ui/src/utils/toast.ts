import { createSignal } from "solid-js";

const [toastMessage, setToastMessage] = createSignal<string | null>(null);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export { toastMessage };

export function showToast(message: string, durationMs = 2000) {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
  }
  setToastMessage(message);
  dismissTimer = setTimeout(() => {
    setToastMessage(null);
    dismissTimer = null;
  }, durationMs);
}
