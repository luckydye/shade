import * as bridge from "../bridge/index";
import type { NativeDragDropPayload } from "../types";

export function listenNativeDragDrop(
  listener: (payload: NativeDragDropPayload) => void,
): Promise<() => void> {
  return bridge.listenNativeDragDrop(listener);
}
