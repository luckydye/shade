import { createResource, createRoot, type InitializedResource } from "solid-js";
import {
  getLocalPeerDiscoverySnapshot,
  pairPeerDevice as pairPeerDeviceBridge,
} from "../bridge/index";
import type { LocalPeer, LocalPeerDiscoverySnapshot } from "../types";

const POLL_INTERVAL_MS = 1500;

const EMPTY_SNAPSHOT: LocalPeerDiscoverySnapshot = {
  local_endpoint_id: "",
  local_direct_addresses: [],
  peers: [],
};

const { snapshot, refetch } = createRoot(() => {
  const [resource, { refetch }] = createResource(getLocalPeerDiscoverySnapshot, {
    initialValue: EMPTY_SNAPSHOT,
  });
  window.setInterval(() => {
    void refetch();
  }, POLL_INTERVAL_MS);
  return { snapshot: resource, refetch };
});

export function usePeerDiscovery(): {
  snapshot: InitializedResource<LocalPeerDiscoverySnapshot>;
  peers: () => LocalPeer[];
  refetch: () => Promise<void>;
  pairPeerDevice: (peerEndpointId: string) => Promise<void>;
} {
  return {
    snapshot,
    peers: () => snapshot().peers,
    refetch: async () => {
      await refetch();
    },
    pairPeerDevice,
  };
}

function pairPeerDevice(peerEndpointId: string): Promise<void> {
  return pairPeerDeviceBridge(peerEndpointId);
}
