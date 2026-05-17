import { type Accessor, createRoot, createSignal } from "solid-js";
import { listenLibrarySyncProgress } from "../bridge/index";
import type { LibrarySyncProgress } from "../bridge/index";

/** Reactive view of the most recent library-sync progress event, or `null`
 * when no sync is in flight. */
const progress = createRoot(() => {
  const [progress, setProgress] = createSignal<LibrarySyncProgress | null>(null);
  listenLibrarySyncProgress((next) => {
    setProgress(next.completed >= next.total ? null : next);
  });
  return progress;
});

export function useLibrarySyncProgress(): Accessor<LibrarySyncProgress | null> {
  return progress;
}
