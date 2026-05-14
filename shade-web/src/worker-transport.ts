import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
} from "shade-ui/src/bridge/channel";
import type { Transport } from "shade-ui/src/bridge/transport";

/**
 * Main-thread Transport backed by a Web Worker.
 *
 * Sends `MutationRequest` / `ReadRequest` envelopes to the worker over
 * `postMessage`; the worker dispatches and posts `ChannelMessage` results
 * back. The transport surface matches the Tauri side — bridge consumers
 * never know the difference.
 */
export function createWorkerTransport(): Transport {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "shade-web-worker",
  });
  const subscribers = new Set<(msg: ChannelMessage) => void>();

  worker.onmessage = (event: MessageEvent<ChannelMessage>) => {
    const msg = event.data;
    for (const handler of subscribers) {
      try {
        handler(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[worker-transport] subscriber threw", err);
      }
    }
  };

  worker.onerror = (event) => {
    // eslint-disable-next-line no-console
    console.error("[worker-transport] worker errored", event);
  };

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
