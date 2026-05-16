import { createStore } from "solid-js/store";
import {
  type AwarenessState,
  applyPeerMetadata as bridgeApplyPeerMetadata,
  getPeerAwareness as bridgeGetPeerAwareness,
  setLocalAwareness as bridgeSetLocalAwareness,
  syncPeerSnapshots as bridgeSyncPeerSnapshots,
  isTauriRuntime,
  type SyncPeerSnapshotsResult,
} from "../bridge";
import { usePeerDiscovery } from "../data/use-peer-discovery";

export interface PeerAwareness {
  endpoint_id: string;
  display_name: string | null;
  active_fingerprint: string | null;
  active_snapshot_id: string | null;
  fetched_at: number;
}

interface SyncState {
  peer_awareness: Record<string, PeerAwareness>;
  is_syncing: boolean;
  last_sync_error: string;
}

const [syncState, setSyncState] = createStore<SyncState>({
  peer_awareness: {},
  is_syncing: false,
  last_sync_error: "",
});

export { syncState };

// ── Awareness ────────────────────────────────────────────────────────────────

export async function setLocalAwareness(
  displayName: string | null,
  fingerprint: string | null,
  snapshotId: string | null,
): Promise<void> {
  if (!(await isTauriRuntime())) return;
  await bridgeSetLocalAwareness(displayName, fingerprint, snapshotId);
}

export async function fetchPeerAwareness(peerId: string): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    const awareness: AwarenessState = await bridgeGetPeerAwareness(peerId);
    setSyncState("peer_awareness", peerId, {
      endpoint_id: peerId,
      display_name: awareness.display_name ?? null,
      active_fingerprint: awareness.active_fingerprint ?? null,
      active_snapshot_id: awareness.active_snapshot_id ?? null,
      fetched_at: Date.now(),
    });
  } catch {
    // Best-effort: ignore errors from individual peers
  }
}

export async function refreshAllPeerAwareness(): Promise<void> {
  const peers = usePeerDiscovery().peers();
  await Promise.allSettled(peers.map((peer) => fetchPeerAwareness(peer.endpoint_id)));
}

/** Returns peers currently viewing or editing the given fingerprint. */
export function getPeersViewingImage(fingerprint: string): PeerAwareness[] {
  return (Object.values(syncState.peer_awareness) as PeerAwareness[]).filter(
    (p) => p.active_fingerprint === fingerprint,
  );
}

// ── Snapshot sync ─────────────────────────────────────────────────────────────

export type { SyncPeerSnapshotsResult };

export async function syncPeerSnapshots(
  peerId: string,
  fingerprint: string,
): Promise<SyncPeerSnapshotsResult> {
  if (!(await isTauriRuntime())) return { synced_ids: [] };
  return bridgeSyncPeerSnapshots(peerId, fingerprint);
}

/** Sync snapshots for a fingerprint from all currently connected peers. */
export async function syncSnapshotsFromAllPeers(fingerprint: string): Promise<string[]> {
  const peers = usePeerDiscovery().peers();
  if (peers.length === 0) return [];
  setSyncState("is_syncing", true);
  setSyncState("last_sync_error", "");
  const allSynced: string[] = [];
  try {
    const results = await Promise.allSettled(
      peers.map((peer) => syncPeerSnapshots(peer.endpoint_id, fingerprint)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        allSynced.push(...result.value.synced_ids);
      }
    }
  } catch (error) {
    setSyncState(
      "last_sync_error",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    setSyncState("is_syncing", false);
  }
  return allSynced;
}

// ── Metadata sync ─────────────────────────────────────────────────────────────

export async function applyPeerMetadata(
  peerId: string,
  fingerprints: string[],
): Promise<void> {
  if (!(await isTauriRuntime())) return;
  await bridgeApplyPeerMetadata(peerId, fingerprints);
}

/** Apply metadata from all connected peers for the given file hashes. */
export async function applyMetadataFromAllPeers(fingerprints: string[]): Promise<void> {
  const peers = usePeerDiscovery().peers();
  if (peers.length === 0 || fingerprints.length === 0) return;
  await Promise.allSettled(
    peers.map((peer) => applyPeerMetadata(peer.endpoint_id, fingerprints)),
  );
}
