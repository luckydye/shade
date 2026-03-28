import type { EditSnapshotInfo, SnapshotInfo } from "./bridge/index";
import type { BrowserPresetLayer } from "./browser-presets";

const DB_NAME = "shade-browser-snapshots";
const DB_VERSION = 1;
const STORE = "snapshots";

interface BrowserSnapshotRecord {
  id: string;
  image_path: string | null;
  display_index: number;
  created_at: number;
  is_current: boolean;
  layers: BrowserPresetLayer[];
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser snapshots");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withReadStore<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const tx = db.transaction([STORE], "readonly");
  const store = tx.objectStore(STORE);
  try {
    return await requestToPromise(run(store));
  } finally {
    db.close();
  }
}

/** Returns snapshots for the given imagePath, ordered by display_index. */
export async function listBrowserSnapshots(imagePath: string | null): Promise<SnapshotInfo[]> {
  const all = (await withReadStore((store) => store.getAll())) as BrowserSnapshotRecord[];
  return all
    .filter((r) => (r.image_path ?? null) === imagePath)
    .sort((a, b) => a.display_index - b.display_index)
    .map((r) => ({
      id: r.id,
      display_index: r.display_index,
      created_at: r.created_at,
      is_current: r.is_current,
      peer_origin: null,
    }));
}

/** Returns a map from image path to the ID of the most recently created snapshot for that path. */
export async function getBrowserSnapshotPathMap(): Promise<Map<string, string>> {
  const all = (await withReadStore((store) => store.getAll())) as BrowserSnapshotRecord[];
  const latestByPath = new Map<string, { id: string; created_at: number }>();
  for (const record of all) {
    const path = record.image_path ?? null;
    if (path === null) continue;
    const existing = latestByPath.get(path);
    if (!existing || record.created_at > existing.created_at) {
      latestByPath.set(path, { id: record.id, created_at: record.created_at });
    }
  }
  return new Map([...latestByPath.entries()].map(([path, { id }]) => [path, id]));
}

export async function getBrowserSnapshot(id: string): Promise<BrowserSnapshotRecord> {
  const result = await withReadStore((store) => store.get(id));
  if (!result || typeof result !== "object") {
    throw new Error(`snapshot not found: ${id}`);
  }
  return result as BrowserSnapshotRecord;
}

/** Returns the current snapshot for the given image path, or null if none exists. */
export async function getBrowserCurrentSnapshot(
  imagePath: string | null,
): Promise<{ id: string; layers: BrowserPresetLayer[] } | null> {
  const all = (await withReadStore((store) => store.getAll())) as BrowserSnapshotRecord[];
  const current = all.find(
    (r) => r.is_current && (r.image_path ?? null) === imagePath,
  );
  return current ? { id: current.id, layers: current.layers } : null;
}

export async function saveBrowserSnapshot(
  layers: BrowserPresetLayer[],
  imagePath: string | null,
): Promise<EditSnapshotInfo> {
  const id = crypto.randomUUID();
  const created_at = Date.now();
  const db = await openDb();
  return new Promise<EditSnapshotInfo>((resolve, reject) => {
    const tx = db.transaction([STORE], "readwrite");
    const store = tx.objectStore(STORE);
    const getAllRequest = store.getAll();
    getAllRequest.onsuccess = () => {
      const existing = getAllRequest.result as BrowserSnapshotRecord[];
      const samePathRecords = existing.filter((r) => (r.image_path ?? null) === imagePath);
      const maxIndex = samePathRecords.reduce((max, r) => Math.max(max, r.display_index), 0);
      for (const record of samePathRecords) {
        if (record.is_current) {
          store.put({ ...record, is_current: false }, record.id);
        }
      }
      store.put({ id, image_path: imagePath, display_index: maxIndex + 1, created_at, is_current: true, layers }, id);
    };
    getAllRequest.onerror = () => reject(getAllRequest.error);
    tx.oncomplete = () => {
      db.close();
      resolve({ id });
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("transaction aborted"));
    };
  });
}

export async function markBrowserSnapshotCurrent(id: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE], "readwrite");
    const store = tx.objectStore(STORE);
    const getAllRequest = store.getAll();
    getAllRequest.onsuccess = () => {
      const all = getAllRequest.result as BrowserSnapshotRecord[];
      const target = all.find((r) => r.id === id);
      if (!target) {
        reject(new Error(`snapshot not found: ${id}`));
        tx.abort();
        return;
      }
      const targetPath = target.image_path ?? null;
      for (const record of all) {
        if ((record.image_path ?? null) !== targetPath) continue;
        const shouldBeCurrent = record.id === id;
        if (record.is_current !== shouldBeCurrent) {
          store.put({ ...record, is_current: shouldBeCurrent }, record.id);
        }
      }
    };
    getAllRequest.onerror = () => reject(getAllRequest.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("transaction aborted"));
    };
  });
}
