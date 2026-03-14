import { Component, For, onCleanup, onMount } from "solid-js";
import { p2pState, startP2pPolling, stopP2pPolling } from "../store/p2p";

function shortId(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export const PeerDiscoveryPanel: Component = () => {
  onMount(() => {
    startP2pPolling();
  });

  onCleanup(() => {
    stopP2pPolling();
  });

  return (
    <section class="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-medium text-white/85">Local Network</h2>
          <p class="mt-1 text-xs text-white/45">
            Device {shortId(p2pState.local_endpoint_id || "starting")}
          </p>
        </div>
        <div class="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/55">
          {p2pState.isLoading ? "Scanning" : `${p2pState.peers.length} peers`}
        </div>
      </div>

      <div class="mt-4 space-y-2">
        <For
          each={p2pState.peers}
          fallback={<p class="text-sm text-white/35">No peers discovered on the local network.</p>}
        >
          {(peer) => (
            <div class="rounded-xl border border-white/7 bg-black/20 px-3 py-2.5">
              <p class="font-mono text-[12px] text-white/80">{shortId(peer.endpoint_id)}</p>
              <p class="mt-1 text-[11px] text-white/45">
                {peer.direct_addresses.length > 0 ? peer.direct_addresses.join(" · ") : "Address pending"}
              </p>
            </div>
          )}
        </For>
      </div>
    </section>
  );
};
