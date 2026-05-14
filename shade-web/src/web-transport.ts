import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
} from "shade-ui/src/bridge/channel";
import type { Transport } from "shade-ui/src/bridge/transport";

/**
 * Stub web transport. Phase A delivers only the protocol abstraction; the
 * real implementation arrives in Phase B as a `new Worker()` that dispatches
 * `MutationRequest` / `ReadRequest` variants. Until then any unified-protocol
 * call from the bridge will reject — the web build is intentionally broken in
 * this interim window per the agreed migration plan.
 */
export function createWebTransport(): Transport {
  const subscribers = new Set<(msg: ChannelMessage) => void>();
  return {
    async sendMutation(request: MutationRequest) {
      throw new Error(
        `web transport: sendMutation(${request.type}) not implemented — Phase B will host a Worker for this`,
      );
    },
    async sendRead(_readId: number, request: ReadRequest) {
      throw new Error(
        `web transport: sendRead(${request.type}) not implemented — Phase B will host a Worker for this`,
      );
    },
    onMessage(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
