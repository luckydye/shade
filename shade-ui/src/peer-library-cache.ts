import {
  getPeerThumbnailBytes,
  listPeerPictures,
  type SharedPicture,
} from "./bridge/index";

const DB_NAME = "shade-peer-cache";
const DB_VERSION = 2;
const LIBRARIES_STORE = "libraries";
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";

export type PeerLibrary = {
  id: string;
  kind: "peer";
  name: string;
  path: null;
  removable: true;
  peerId: string;
};

export type PeerLibraryItem = {
  kind: "peer";
  id: string;
  name: string;
  peerId: string;
  modified_at: number | null;
};

type CachedPeerItem = {
  peerId: string;
  pictureId: string;
  name: string;
  modified_at: number | null;
};

function normalizeModifiedAt(modifiedAt: unknown) {
  return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
    ? modifiedAt
    : null;
}

function normalizeSharedPicture(picture: SharedPicture): SharedPicture {
  return {
    id: picture.id,
    name: picture.name,
    modified_at: normalizeModifiedAt(
      (picture as SharedPicture & { modified_at?: unknown }).modified_at,
    ),
  };
}

function peerLibraryId(peerId: string) {
  return `peer:${peerId}`;
}

function peerLibraryName(peerId: string) {
  return `Peer ${peerId.slice(0, 8)}`;
}

function thumbnailKey(peerId: string, pictureId: string) {
  return `${peerId}:${pictureId}`;
}

function abortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("thumbnail load aborted", "AbortError");
  }
  return new Error("thumbnail load aborted");
}

function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for peer caching");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARIES_STORE)) {
        db.createObjectStore(LIBRARIES_STORE);
      }
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE);
      }
      if (!db.objectStoreNames.contains(THUMBNAILS_STORE)) {
        db.createObjectStore(THUMBNAILS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStores<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const stores = Object.fromEntries(
    storeNames.map((name) => [name, tx.objectStore(name)]),
  ) as Record<string, IDBObjectStore>;
  try {
    const result = await run(stores);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function toPeerLibrary(peerId: string): PeerLibrary {
  return {
    id: peerLibraryId(peerId),
    kind: "peer",
    name: peerLibraryName(peerId),
    path: null,
    removable: true,
    peerId,
  };
}

function toPeerLibraryItems(
  peerId: string,
  pictures: SharedPicture[],
): PeerLibraryItem[] {
  return pictures.map((picture) => ({
    kind: "peer",
    id: picture.id,
    name: picture.name,
    peerId,
    modified_at: normalizeModifiedAt(picture.modified_at),
  }));
}

async function loadPeerLibraryIds() {
  return withStores([LIBRARIES_STORE], "readonly", async (stores) => {
    const keys = await requestToPromise(stores[LIBRARIES_STORE].getAllKeys());
    return keys.filter((value): value is string => typeof value === "string");
  });
}

async function addPeerLibraryId(peerId: string) {
  await withStores([LIBRARIES_STORE], "readwrite", async (stores) => {
    await requestToPromise(stores[LIBRARIES_STORE].put(true, peerId));
  });
}

async function removePeerLibraryId(peerId: string) {
  await withStores([LIBRARIES_STORE], "readwrite", async (stores) => {
    await requestToPromise(stores[LIBRARIES_STORE].delete(peerId));
  });
}

function peerItemKey(peerId: string, pictureId: string) {
  return `${peerId}:${pictureId}`;
}

function toCachedPeerItem(peerId: string, picture: SharedPicture): CachedPeerItem {
  return {
    peerId,
    pictureId: picture.id,
    name: picture.name,
    modified_at: normalizeModifiedAt(picture.modified_at),
  };
}

function toSharedPicture(item: CachedPeerItem): SharedPicture {
  return {
    id: item.pictureId,
    name: item.name,
    modified_at: normalizeModifiedAt(item.modified_at),
  };
}

async function loadPeerLibraryItems(peerId: string) {
  return withStores([ITEMS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[ITEMS_STORE].getAll());
    return Array.isArray(result)
      ? result
          .map((item) => item as CachedPeerItem)
          .filter((item) => item.peerId === peerId)
          .map(toSharedPicture)
      : [];
  });
}

async function savePeerLibraryItems(peerId: string, pictures: SharedPicture[]) {
  await withStores([ITEMS_STORE], "readwrite", async (stores) => {
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${peerId}:`))
        .map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
    await Promise.all(
      pictures
        .map(normalizeSharedPicture)
        .map((picture) => toCachedPeerItem(peerId, picture))
        .map((picture) =>
          requestToPromise(
            stores[ITEMS_STORE].put(
              picture,
              peerItemKey(picture.peerId, picture.pictureId),
            ),
          ),
        ),
    );
  });
}

async function getCachedThumbnail(
  peerId: string,
  pictureId: string,
): Promise<Blob | null> {
  return withStores([THUMBNAILS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(
      stores[THUMBNAILS_STORE].get(thumbnailKey(peerId, pictureId)),
    );
    return result instanceof Blob ? result : null;
  });
}

async function putCachedThumbnail(
  peerId: string,
  pictureId: string,
  blob: Blob,
): Promise<void> {
  await withStores([THUMBNAILS_STORE], "readwrite", async (stores) => {
    await requestToPromise(
      stores[THUMBNAILS_STORE].put(blob, thumbnailKey(peerId, pictureId)),
    );
  });
}

async function deleteCachedPeerThumbnails(peerId: string): Promise<void> {
  await withStores([THUMBNAILS_STORE], "readwrite", async (stores) => {
    const keys = await requestToPromise(stores[THUMBNAILS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${peerId}:`))
        .map((key) => requestToPromise(stores[THUMBNAILS_STORE].delete(key))),
    );
  });
}

async function warmPeerLibraryThumbnails(peerId: string, pictures: SharedPicture[]) {
  const workerCount = 4;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < pictures.length) {
      const picture = pictures[nextIndex];
      nextIndex += 1;
      if (await getCachedThumbnail(peerId, picture.id)) {
        continue;
      }
      try {
        const bytes = await getPeerThumbnailBytes(peerId, picture.id);
        await putCachedThumbnail(
          peerId,
          picture.id,
          new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" }),
        );
      } catch {
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function listPeerLibraries(): Promise<PeerLibrary[]> {
  return (await loadPeerLibraryIds()).map(toPeerLibrary);
}

export async function getCachedPeerLibraryItems(
  peerId: string,
): Promise<PeerLibraryItem[]> {
  return toPeerLibraryItems(peerId, await loadPeerLibraryItems(peerId));
}

export async function addPeerLibrary(peerId: string): Promise<PeerLibrary> {
  const peerIds = await loadPeerLibraryIds();
  if (!peerIds.includes(peerId)) {
    await addPeerLibraryId(peerId);
  }
  return toPeerLibrary(peerId);
}

export async function removePeerLibrary(peerId: string): Promise<void> {
  await removePeerLibraryId(peerId);
  await withStores([ITEMS_STORE], "readwrite", async (stores) => {
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${peerId}:`))
        .map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
  });
  await deleteCachedPeerThumbnails(peerId);
}

export async function loadPeerLibraryItemsCachedOrRemote(
  peerId: string,
): Promise<PeerLibraryItem[]> {
  try {
    const pictures = await listPeerPictures(peerId);
    await savePeerLibraryItems(peerId, pictures);
    void warmPeerLibraryThumbnails(peerId, pictures);
    return toPeerLibraryItems(peerId, pictures);
  } catch (error) {
    const cachedItems = await loadPeerLibraryItems(peerId);
    if (cachedItems.length > 0) {
      return toPeerLibraryItems(peerId, cachedItems);
    }
    throw error;
  }
}

export async function resolvePeerThumbnailSrc(
  peerId: string,
  pictureId: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  const cached = await getCachedThumbnail(peerId, pictureId);
  if (cached) {
    return URL.createObjectURL(cached);
  }
  const bytes = await getPeerThumbnailBytes(peerId, pictureId);
  if (signal.aborted) {
    throw abortError();
  }
  const blob = new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" });
  await putCachedThumbnail(peerId, pictureId, blob);
  return URL.createObjectURL(blob);
}
