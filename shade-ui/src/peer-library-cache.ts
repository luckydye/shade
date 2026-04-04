import { getThumbnailBackend } from "./bridge/thumbnail-backend";
import { listPeerPictures, type SharedPicture } from "./bridge/index";
import {
  abortError,
  normalizeModifiedAt,
  requestToPromise,
  toBlobBuffer,
  withStores,
} from "./cache-utils";

const DB_NAME = "shade-peer-cache";
const DB_VERSION = 4;
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";

export type PeerLibraryItem = {
  kind: "peer";
  id: string;
  name: string;
  peerId: string;
  modified_at: number | null;
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
};

type CachedPeerItem = {
  peerId: string;
  pictureId: string;
  name: string;
  modified_at: number | null;
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
};

function normalizeSharedPicture(picture: SharedPicture): SharedPicture {
  return {
    id: picture.id,
    name: picture.name,
    modified_at: normalizeModifiedAt(
      (picture as SharedPicture & { modified_at?: unknown }).modified_at,
    ),
    has_snapshots: picture.has_snapshots ?? false,
    latest_snapshot_id: picture.latest_snapshot_id ?? null,
  };
}

function thumbnailKey(peerId: string, pictureId: string) {
  return `${peerId}:${pictureId}`;
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
      if (db.objectStoreNames.contains("libraries")) {
        db.deleteObjectStore("libraries");
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

function toPeerLibraryItems(
  peerId: string,
  pictures: SharedPicture[],
): PeerLibraryItem[] {
  return pictures
    .map((picture): PeerLibraryItem => ({
      kind: "peer",
      id: picture.id,
      name: picture.name,
      peerId,
      modified_at: normalizeModifiedAt(picture.modified_at),
      has_snapshots: picture.has_snapshots ?? false,
      latest_snapshot_id: picture.latest_snapshot_id ?? null,
    }))
    .sort((left, right) => {
      const leftModifiedAt = left.modified_at ?? 0;
      const rightModifiedAt = right.modified_at ?? 0;
      return (
        rightModifiedAt - leftModifiedAt ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
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
    has_snapshots: picture.has_snapshots ?? false,
    latest_snapshot_id: picture.latest_snapshot_id ?? null,
  };
}

function toSharedPicture(item: CachedPeerItem): SharedPicture {
  return {
    id: item.pictureId,
    name: item.name,
    modified_at: normalizeModifiedAt(item.modified_at),
    has_snapshots: item.has_snapshots ?? false,
    latest_snapshot_id: item.latest_snapshot_id ?? null,
  };
}

async function loadPeerLibraryItems(peerId: string) {
  return withStores(openDb, [ITEMS_STORE], "readonly", async (stores) => {
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
  await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
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
  return withStores(openDb, [THUMBNAILS_STORE], "readonly", async (stores) => {
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
  await withStores(openDb, [THUMBNAILS_STORE], "readwrite", async (stores) => {
    await requestToPromise(
      stores[THUMBNAILS_STORE].put(blob, thumbnailKey(peerId, pictureId)),
    );
  });
}

async function deleteCachedPeerThumbnails(peerId: string): Promise<void> {
  await withStores(openDb, [THUMBNAILS_STORE], "readwrite", async (stores) => {
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
        const bytes = await getThumbnailBackend().getPeerThumbnailBytes(peerId,picture.id);
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

export async function getCachedPeerLibraryItems(
  peerId: string,
): Promise<PeerLibraryItem[]> {
  return toPeerLibraryItems(peerId, await loadPeerLibraryItems(peerId));
}

export async function removePeerLibrary(peerId: string): Promise<void> {
  await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
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
  const bytes = await getThumbnailBackend().getPeerThumbnailBytes(peerId, pictureId);
  if (signal.aborted) {
    throw abortError();
  }
  const blob = new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" });
  await putCachedThumbnail(peerId, pictureId, blob);
  return URL.createObjectURL(blob);
}
