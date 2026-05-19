import { createRoot, createSignal } from "solid-js";

const {
  mediaViewActionStatus,
  mediaViewError,
  setMediaViewActionStatus,
  setMediaViewError,
} = createRoot(() => {
  const [mediaViewActionStatus, setMediaViewActionStatus] = createSignal<string | null>(
    null,
  );
  const [mediaViewError, setMediaViewError] = createSignal<string | null>(null);
  return {
    mediaViewActionStatus,
    mediaViewError,
    setMediaViewActionStatus,
    setMediaViewError,
  };
});

export function useMediaViewStatus() {
  return {
    mediaViewActionStatus,
    mediaViewError,
    setMediaViewActionStatus,
    setMediaViewError,
  };
}
