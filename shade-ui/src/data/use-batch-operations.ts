import { type Accessor, createRoot, createSignal } from "solid-js";
import * as bridge from "../bridge/index";
import type { BatchExportItem, BatchExportProgress } from "../bridge/types";

/** Reactive view of the most recent batch-export progress event, or `null`
 * when no batch export is in flight. */
const exportProgress = createRoot(() => {
  const [progress, setProgress] = createSignal<BatchExportProgress | null>(null);
  bridge.listenBatchExportProgress((next) => {
    setProgress(next.completed >= next.total ? null : next);
  });
  return progress;
});

function applyPresetSnapshot(
  items: { path: string; fingerprint: string | null }[],
  name: string,
): Promise<number> {
  return bridge.batchApplyPresetSnapshot(items, name);
}

function clearEdits(paths: string[]): Promise<number> {
  return bridge.batchClearEdits(paths);
}

function exportImages(items: BatchExportItem[], targetDir: string): Promise<number> {
  return bridge.batchExportImages(items, targetDir);
}

export function useBatchOperations(): {
  applyPresetSnapshot: typeof applyPresetSnapshot;
  clearEdits: typeof clearEdits;
  exportImages: typeof exportImages;
  exportProgress: Accessor<BatchExportProgress | null>;
} {
  return { applyPresetSnapshot, clearEdits, exportImages, exportProgress };
}
