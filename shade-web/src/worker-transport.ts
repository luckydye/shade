import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
  Transport,
} from "shade-ui/src/types";

// Singleton Worker instance. Both the unified Transport (this file) and the
// legacy `workerCall` path in shade-ui/bridge/index.ts (via
// `platform.ts.createWorker`) funnel through the same Worker so editor
// state (the wasm stack) stays consistent across both protocols.
let _worker: Worker | null = null;

export function getSharedWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL("shade-wasm/web/worker/index.ts", import.meta.url), {
      type: "module",
      name: "shade-web-worker",
    });
  }
  return _worker;
}

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
    sendPreviewViewports() {
      // Web preview pipeline doesn't route through `update_preview_viewports`
      // — it uses the legacy renderPreview workerCall path. No-op.
    },
  };
}
