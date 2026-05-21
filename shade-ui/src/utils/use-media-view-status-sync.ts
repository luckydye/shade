import { type Accessor, createEffect, onCleanup } from "solid-js";
import { useMediaViewStatus } from "./use-media-view-status";

export function useMediaViewStatusSync(params: {
  displayedError: Accessor<string | null>;
  mediaActionStatus: Accessor<string | null>;
}) {
  const { setMediaViewActionStatus, setMediaViewError } = useMediaViewStatus();

  createEffect(() => {
    setMediaViewError(params.displayedError());
  });
  createEffect(() => {
    setMediaViewActionStatus(params.mediaActionStatus());
  });
  onCleanup(() => {
    setMediaViewActionStatus(null);
    setMediaViewError(null);
  });
}
