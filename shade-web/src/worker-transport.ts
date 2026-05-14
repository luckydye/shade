import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
} from "shade-ui/src/bridge/channel";
import type { Transport } from "shade-ui/src/bridge/transport";
import { getSharedWorker } from "./shared-worker";

// Heuristic: the unified protocol's outbound payloads always carry a `type`
// string that matches one of the known ChannelMessage variants. Legacy
// messages (`{ type, requestId, pixels, ... }`) overlap, so the cheap test
// is "no requestId field present".
function isUnifiedMessage(data: unknown): data is ChannelMessage {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  // Legacy messages always carry `requestId`; unified ones never do.
  return !("requestId" in obj);
}

/**
 * Main-thread Transport backed by the shared web worker. Routes
 * `MutationRequest` / `ReadRequest` envelopes outbound, and dispatches
 * ChannelMessage-shaped payloads inbound. Coexists with the bridge's
 * legacy `worker.onmessage` handler — both fire for every message; each
 * filters by payload shape.
 */
export function createWorkerTransport(): Transport {
  const worker = getSharedWorker();
  const subscribers = new Set<(msg: ChannelMessage) => void>();

  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!isUnifiedMessage(data)) return;
    for (const handler of subscribers) {
      try {
        handler(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[worker-transport] subscriber threw", err);
      }
    }
  });

  worker.addEventListener("error", (event) => {
    // eslint-disable-next-line no-console
    console.error("[worker-transport] worker errored", event);
  });

  return {
    async sendMutation(request: MutationRequest) {
      worker.postMessage({ kind: "mutation", request });
    },
    async sendRead(readId: number, request: ReadRequest) {
      worker.postMessage({ kind: "read", readId, request });
    },
    onMessage(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
