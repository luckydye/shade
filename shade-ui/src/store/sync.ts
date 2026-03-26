import { createStore } from "solid-js/store";
import { p2pState } from "./p2p";
import {
  isTauriRuntime,
  getPeerAwareness as bridgeGetPeerAwareness,
  setLocalAwareness as bridgeSetLocalAwareness,
  syncPeerSnapshots as bridgeSyncPeerSnapshots,
  applyPeerMetadata as bridgeApplyPeerMetadata,
  type AwarenessState,
  type SyncPeerSnapshotsResult,
  type ApplyPeerMetadataResult,
} from "../bridge";

export interface PeerAwareness {
  endpoint_id: string;
  display_name: string | null;
  active_file_hash: string | null;
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
  fileHash: string | null,
  snapshotId: string | null,
): Promise<void> {
  if (!(await isTauriRuntime())) return;
  await bridgeSetLocalAwareness(displayName, fileHash, snapshotId);
}

export async function fetchPeerAwareness(peerId: string): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    const awareness: AwarenessState = await bridgeGetPeerAwareness(peerId);
    setSyncState("peer_awareness", peerId, {
      endpoint_id: peerId,
      display_name: awareness.display_name ?? null,
      active_file_hash: awareness.active_file_hash ?? null,
      active_snapshot_id: awareness.active_snapshot_id ?? null,
      fetched_at: Date.now(),
    });
  } catch {
    // Best-effort: ignore errors from individual peers
  }
}

export async function refreshAllPeerAwareness(): Promise<void> {
  const peers = p2pState.peers;
  await Promise.allSettled(peers.map((peer) => fetchPeerAwareness(peer.endpoint_id)));
}

/** Returns peers currently viewing or editing the given file_hash. */
export function getPeersViewingImage(fileHash: string): PeerAwareness[] {
  return (Object.values(syncState.peer_awareness) as PeerAwareness[]).filter(
    (p) => p.active_file_hash === fileHash,
  );
}

// ── Snapshot sync ─────────────────────────────────────────────────────────────

export type { SyncPeerSnapshotsResult };

export async function syncPeerSnapshots(
  peerId: string,
  fileHash: string,
): Promise<SyncPeerSnapshotsResult> {
  if (!(await isTauriRuntime())) return { synced_ids: [] };
  return bridgeSyncPeerSnapshots(peerId, fileHash);
}

/** Sync snapshots for a file_hash from all currently connected peers. */
export async function syncSnapshotsFromAllPeers(
  fileHash: string,
): Promise<string[]> {
  const peers = p2pState.peers;
  if (peers.length === 0) return [];
  setSyncState("is_syncing", true);
  setSyncState("last_sync_error", "");
  const allSynced: string[] = [];
  try {
    const results = await Promise.allSettled(
      peers.map((peer) => syncPeerSnapshots(peer.endpoint_id, fileHash)),
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

export type { ApplyPeerMetadataResult };

export async function applyPeerMetadata(
  peerId: string,
  fileHashes: string[],
): Promise<ApplyPeerMetadataResult> {
  if (!(await isTauriRuntime())) return { ratings_updated: 0, tags_added: 0 };
  return bridgeApplyPeerMetadata(peerId, fileHashes);
}

/** Apply metadata from all connected peers for the given file hashes. */
export async function applyMetadataFromAllPeers(
  fileHashes: string[],
): Promise<void> {
  const peers = p2pState.peers;
  if (peers.length === 0 || fileHashes.length === 0) return;
  await Promise.allSettled(
    peers.map((peer) => applyPeerMetadata(peer.endpoint_id, fileHashes)),
  );
}
