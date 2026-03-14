import { Component, createResource, For, Show } from "solid-js";
import { getPeerThumbnail } from "../bridge/index";
import { p2pState, selectPeer } from "../store/p2p";

const RemoteImageTile: Component<{ peerId: string; pictureId: string; name: string }> = (props) => {
  const [src] = createResource(
    () => (props.peerId ? `${props.peerId}:${props.pictureId}` : undefined),
    async () => getPeerThumbnail(props.peerId, props.pictureId),
  );

  return (
    <div class="flex flex-col gap-1.5 rounded-xl">
      <div class="relative aspect-square w-full overflow-hidden rounded-lg bg-white/[0.04]">
        <Show when={src()} fallback={<div class="h-full w-full animate-pulse bg-white/[0.06]" />}>
          <img
            src={src()}
            alt={props.name}
            class="h-full w-full object-contain"
            loading="lazy"
          />
        </Show>
      </div>
      <span class="truncate px-0.5 text-[11px] text-white/40">{props.name}</span>
    </div>
  );
};

export const PeerBrowser: Component = () => (
  <section class="rounded-2xl border border-white/8 bg-white/[0.035] p-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-sm font-medium text-white/85">Peer Browser</h2>
        <p class="mt-1 text-xs text-white/45">
          Browse shared images over a discovered peer.
        </p>
      </div>
      <div class="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/55">
        {p2pState.isLoadingPeerPictures ? "Loading" : `${p2pState.remotePictures.length} images`}
      </div>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <For each={p2pState.peers}>
        {(peer) => (
          <button
            type="button"
            class={`rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
              p2pState.selectedPeerId === peer.endpoint_id
                ? "border-stone-100 bg-stone-100 text-stone-950"
                : "border-white/10 bg-white/[0.04] text-white/70"
            }`}
            onClick={() => {
              void selectPeer(peer.endpoint_id);
            }}
          >
            {peer.endpoint_id.slice(0, 8)}
          </button>
        )}
      </For>
    </div>

    <div class="mt-4">
      <Show when={p2pState.selectedPeerId} fallback={<p class="text-sm text-white/35">Select a peer to browse its images.</p>}>
        <Show when={!p2pState.isLoadingPeerPictures && p2pState.remotePictures.length > 0} fallback={<p class="text-sm text-white/35">No shared images returned by this peer.</p>}>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            <For each={p2pState.remotePictures}>
              {(picture) => (
                <RemoteImageTile
                  peerId={p2pState.selectedPeerId}
                  pictureId={picture.id}
                  name={picture.name}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  </section>
);
