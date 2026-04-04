export interface ThumbnailBackend {
  getThumbnailBytes(path: string): Promise<Uint8Array>;
  getPeerThumbnailBytes(peerId: string, pictureId: string): Promise<Uint8Array>;
}

let _backend: ThumbnailBackend | null = null;

export function setThumbnailBackend(backend: ThumbnailBackend): void {
  _backend = backend;
}

export function getThumbnailBackend(): ThumbnailBackend {
  if (!_backend) throw new Error("thumbnail backend not initialized");
  return _backend;
}

// ── Implementations ──────────────────────────────────────────────────────────

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null =
  null;

async function getInvoke() {
  if (!_invoke) {
    const { invoke } = await import("@tauri-apps/api/core");
    _invoke = invoke as unknown as typeof _invoke;
  }
  return _invoke!;
}

function normalizeBytes(
  result: number[] | Uint8Array | ArrayBuffer,
): Uint8Array {
  if (result instanceof Uint8Array) return Uint8Array.from(result);
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  return Uint8Array.from(result as number[]);
}

export const tauriThumbnailBackend: ThumbnailBackend = {
  async getThumbnailBytes(path) {
    const inv = await getInvoke();
    return normalizeBytes(
      (await inv("get_thumbnail", { path })) as number[] | Uint8Array | ArrayBuffer,
    );
  },
  async getPeerThumbnailBytes(peerId, pictureId) {
    const inv = await getInvoke();
    return normalizeBytes(
      (await inv("get_peer_thumbnail", {
        peerEndpointId: peerId,
        pictureId,
      })) as number[] | Uint8Array | ArrayBuffer,
    );
  },
};
