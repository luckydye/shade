/**
 * Lazy-initialised shared web worker for shade-web. Both the unified
 * Transport and the legacy `workerCall` path in shade-ui/bridge/index.ts
 * funnel through this single worker instance so editor state (the wasm
 * stack) is consistent across both protocols.
 *
 * Each protocol gets its own listener:
 *
 *   * Transport listens via `addEventListener("message", ...)` for
 *     ChannelMessage-shaped payloads.
 *   * Bridge's legacy multiplexer keeps setting `worker.onmessage` for
 *     `{ type, requestId, ... }`-shaped payloads. Both fire side-by-side.
 */

let _worker: Worker | null = null;

export function getSharedWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL("./worker/index.ts", import.meta.url), {
      type: "module",
      name: "shade-web-worker",
    });
  }
  return _worker;
}
