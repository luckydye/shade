import { onChannelMessage } from "../bridge/channel";

/** Subscribe to `image_open_phase` events for the duration of one open operation.
 * Returns the unsubscribe function. */
export function onImageOpenPhase(handler: (phase: string) => void): () => void {
  return onChannelMessage("image_open_phase", (msg) => handler(msg.phase));
}
