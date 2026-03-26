import { createStore } from "solid-js/store";
import { p2pState } from "./p2p";

export interface PeerAwareness {
  endpoint_id: string;
  display_name?: string | null;
  active_file_hash?: string | null;
  active_snapshot_id?: string | null;
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
  fileHash: string | null,
  snapshotId: string | null,
): Promise<void> {
  if (!(await isTauriRuntime())) return;
  const inv = await getTauriInvoke();
  await inv("set_local_awareness", {
    fileHash: fileHash ?? null,
    snapshotId: snapshotId ?? null,
  });
}

export async function fetchPeerAwareness(peerId: string): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    const inv = await getTauriInvoke();
    const awareness = (await inv("get_peer_awareness", {
      peerEndpointId: peerId,
    })) as {
      display_name?: string | null;
      active_file_hash?: string | null;
      active_snapshot_id?: string | null;
    };
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

export interface SyncPeerSnapshotsResult {
  synced_ids: string[];
}

export async function syncPeerSnapshots(
  peerId: string,
  fileHash: string,
): Promise<SyncPeerSnapshotsResult> {
  if (!(await isTauriRuntime())) return { synced_ids: [] };
  const inv = await getTauriInvoke();
  return inv("sync_peer_snapshots", {
    peerEndpointId: peerId,
    fileHash,
  }) as Promise<SyncPeerSnapshotsResult>;
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

// ── Internal helpers (lazy Tauri imports matching bridge pattern) ──────────────

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let _invoke: InvokeFn | null = null;

async function isTauriRuntime(): Promise<boolean> {
  const { isTauri } = await import("@tauri-apps/api/core");
  return (isTauri as () => boolean)();
}

async function getTauriInvoke(): Promise<InvokeFn> {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke as unknown as InvokeFn;
  }
  return _invoke!;
}
