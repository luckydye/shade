import { createStore } from "solid-js/store";
import {
  getLocalPeerDiscoverySnapshot,
  listPeerPictures,
  type LocalPeerDiscoverySnapshot,
  type SharedPicture,
} from "../bridge/index";

interface P2pState extends LocalPeerDiscoverySnapshot {
  isLoading: boolean;
  selectedPeerId: string;
  remotePictures: SharedPicture[];
  isLoadingPeerPictures: boolean;
  peerBrowserError: string;
}

const [state, setState] = createStore<P2pState>({
  local_endpoint_id: "",
  local_direct_addresses: [],
  peers: [],
  isLoading: false,
  selectedPeerId: "",
  remotePictures: [],
  isLoadingPeerPictures: false,
  peerBrowserError: "",
});

let refreshTimer: number | null = null;
let refreshPromise: Promise<void> | null = null;

export { state as p2pState };

export async function refreshP2pState() {
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = (async () => {
    setState("isLoading", true);
    try {
      const snapshot = await getLocalPeerDiscoverySnapshot();
      setState({
        ...snapshot,
        isLoading: false,
      });
    } catch (error) {
      setState("isLoading", false);
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function startP2pPolling() {
  if (refreshTimer !== null) {
    return;
  }
  void refreshP2pState().catch((error) => {
    console.warn("failed to refresh p2p state", error);
  });
  refreshTimer = window.setInterval(() => {
    void refreshP2pState().catch((error) => {
      console.warn("failed to refresh p2p state", error);
    });
  }, 1500);
}

export function stopP2pPolling() {
  if (refreshTimer === null) {
    return;
  }
  window.clearInterval(refreshTimer);
  refreshTimer = null;
}

export async function selectPeer(peerId: string) {
  if (!peerId) {
    setState({
      selectedPeerId: "",
      remotePictures: [],
      isLoadingPeerPictures: false,
      peerBrowserError: "",
    });
    return;
  }
  setState({
    selectedPeerId: peerId,
    remotePictures: [],
    isLoadingPeerPictures: true,
    peerBrowserError: "",
  });
  try {
    const remotePictures = await listPeerPictures(peerId);
    if (state.selectedPeerId !== peerId) {
      return;
    }
    setState({
      selectedPeerId: peerId,
      remotePictures,
      isLoadingPeerPictures: false,
      peerBrowserError: "",
    });
  } catch (error) {
    if (state.selectedPeerId !== peerId) {
      return;
    }
    setState({
      isLoadingPeerPictures: false,
      peerBrowserError: error instanceof Error ? error.message : String(error),
    });
  }
}
