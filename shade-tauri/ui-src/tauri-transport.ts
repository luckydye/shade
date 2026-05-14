import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
} from "shade-ui/src/bridge/channel";
import type { Transport } from "shade-ui/src/bridge/transport";

/**
 * Tauri-side transport implementation. Wraps invoke for outbound
 * mutation/read requests and a `Channel<ChannelMessage>` for inbound
 * notifications. Registered once at app startup via `setTransport`.
 */
export function createTauriTransport(): Transport {
  const subscribers = new Set<(msg: ChannelMessage) => void>();
  const channel = new Channel<ChannelMessage>((msg) => {
    for (const handler of subscribers) {
      try {
        handler(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[tauri-transport] subscriber threw", err);
      }
    }
  });
  // Defer Rust-side registration until the first subscriber is attached.
  // Otherwise the initial `LayerStackSnapshot` Rust pushes from
  // `register_coordination_channel` would race with the bridge's dispatcher
  // attaching, and could be dropped.
  let registered = false;

  return {
    async sendMutation(request: MutationRequest) {
      await invoke("dispatch_mutation", { request });
    },
    async sendRead(readId: number, request: ReadRequest) {
      await invoke("dispatch_read", { readId, request });
    },
    onMessage(handler) {
      subscribers.add(handler);
      if (!registered) {
        registered = true;
        void invoke("register_coordination_channel", { channel }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            "[tauri-transport] register_coordination_channel failed",
            err,
          );
        });
      }
      return () => {
        subscribers.delete(handler);
      };
    },
    sendPreviewViewports(args) {
      void invoke("update_preview_viewports", {
        generation: args.generation,
        quality: args.quality,
        viewports: args.viewports,
        useFloat16: args.use_float16 ?? false,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[tauri-transport] update_preview_viewports failed", err);
      });
    },
  };
}
