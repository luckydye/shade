import { type Accessor, createRoot, createSignal } from "solid-js";
import type { BatchExportProgress } from "../bridge/index";
import { listenBatchExportProgress } from "../bridge/index";

/** Reactive view of the most recent batch-export progress event, or `null`
 * when no batch export is in flight. */
const progress = createRoot(() => {
  const [progress, setProgress] = createSignal<BatchExportProgress | null>(null);
  listenBatchExportProgress((next) => {
    setProgress(next.completed >= next.total ? null : next);
  });
  return progress;
});

export function useBatchExportProgress(): Accessor<BatchExportProgress | null> {
  return progress;
}
