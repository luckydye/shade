import * as bridge from "../bridge/index";
import type { BatchExportItem } from "../bridge/index";

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

export function useBatchOperations() {
  return { applyPresetSnapshot, clearEdits, exportImages };
}
