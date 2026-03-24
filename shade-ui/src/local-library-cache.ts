import {
  getThumbnailBytes,
  isTauriRuntime,
  listLibraryImages,
  type LibraryImage,
  type LibraryImageListing,
} from "./bridge/index";

const DB_NAME = "shade-local-library-cache";
const DB_VERSION = 2;
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";
const FAILURE_COOLDOWN_MS = 5_000;

type CachedFailures = Map<string, { error: unknown; retryAt: number }>;

type CachedLocalItem = {
  libraryId: string;
  path: string;
  name: string;
  modified_at: number | null;
  has_snapshots: boolean;
  latest_snapshot_version: number | null;
  rating: number | null;
};

const failedThumbnailLoads: CachedFailures = new Map();
const tauriLocalLibraryListings = new Map<string, LibraryImageListing>();

function normalizeModifiedAt(modifiedAt: unknown) {
  return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
    ? modifiedAt
    : null;
}

function normalizeRating(rating: unknown) {
  return typeof rating === "number" &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
    ? rating
    : null;
}

function normalizeSnapshotVersion(version: unknown) {
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

function normalizeLibraryImage(image: LibraryImage): LibraryImage {
  return {
    path: image.path,
    name: image.name,
    modified_at: normalizeModifiedAt(
      (image as LibraryImage & { modified_at?: unknown }).modified_at,
    ),
    metadata: {
      has_snapshots: image.metadata?.has_snapshots ?? false,
      latest_snapshot_version: normalizeSnapshotVersion(
        image.metadata?.latest_snapshot_version,
      ),
      rating: normalizeRating(image.metadata?.rating),
    },
  };
}

function toCachedLocalItem(libraryId: string, image: LibraryImage): CachedLocalItem {
  return {
    libraryId,
    path: image.path,
    name: image.name,
    modified_at: normalizeModifiedAt(image.modified_at),
    has_snapshots: image.metadata?.has_snapshots ?? false,
    latest_snapshot_version: normalizeSnapshotVersion(
      image.metadata?.latest_snapshot_version,
    ),
    rating: normalizeRating(image.metadata?.rating),
  };
}

function toLibraryImage(item: CachedLocalItem): LibraryImage {
  return {
    path: item.path,
    name: item.name,
    modified_at: normalizeModifiedAt(item.modified_at),
    metadata: {
      has_snapshots: item.has_snapshots,
      latest_snapshot_version: normalizeSnapshotVersion(item.latest_snapshot_version),
      rating: normalizeRating(item.rating),
    },
  };
}

function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function normalizeLibraryImageListing(listing: LibraryImageListing): LibraryImageListing {
  return {
    items: listing.items.map(normalizeLibraryImage),
    is_complete: listing.is_complete,
  };
}

function abortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("thumbnail load aborted", "AbortError");
  }
  return new Error("thumbnail load aborted");
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for local library caching");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE);
      }
      if (!db.objectStoreNames.contains(THUMBNAILS_STORE)) {
        db.createObjectStore(THUMBNAILS_STORE);
      }
      if (db.objectStoreNames.contains("libraries")) {
        db.deleteObjectStore("libraries");
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

function localItemKey(libraryId: string, path: string) {
  return `${libraryId}:${path}`;
}

async function loadLocalLibraryListing(libraryId: string): Promise<LibraryImageListing> {
  return withStores([ITEMS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[ITEMS_STORE].getAll());
    const items = Array.isArray(result)
      ? result
          .map((item) => item as CachedLocalItem)
          .filter((item) => item.libraryId === libraryId)
          .map(toLibraryImage)
      : [];
    return {
      items,
      is_complete: true,
    };
  });
}

async function saveLocalLibraryListing(
  libraryId: string,
  listing: LibraryImageListing,
): Promise<void> {
  await withStores([ITEMS_STORE], "readwrite", async (stores) => {
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(`${libraryId}:`))
        .map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
    await Promise.all(
      listing.items
        .map(normalizeLibraryImage)
        .map((item) => toCachedLocalItem(libraryId, item))
        .map((item) =>
          requestToPromise(
            stores[ITEMS_STORE].put(item, localItemKey(item.libraryId, item.path)),
          ),
        ),
    );
  });
}

function thumbnailKey(path: string, latestSnapshotVersion: number | null) {
  return `${path}::snapshot:${latestSnapshotVersion ?? 0}`;
}

async function getCachedThumbnail(
  path: string,
  latestSnapshotVersion: number | null,
): Promise<Blob | null> {
  return withStores([THUMBNAILS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(
      stores[THUMBNAILS_STORE].get(thumbnailKey(path, latestSnapshotVersion)),
    );
    return result instanceof Blob ? result : null;
  });
}

async function putCachedThumbnail(
  path: string,
  latestSnapshotVersion: number | null,
  blob: Blob,
): Promise<void> {
  await withStores([THUMBNAILS_STORE], "readwrite", async (stores) => {
    await requestToPromise(
      stores[THUMBNAILS_STORE].put(blob, thumbnailKey(path, latestSnapshotVersion)),
    );
  });
}

async function warmLocalLibraryThumbnails(items: LibraryImage[]) {
  const workerCount = 4;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (!item) {
        continue;
      }
      const latestSnapshotVersion = normalizeSnapshotVersion(
        item.metadata?.latest_snapshot_version,
      );
      if (await getCachedThumbnail(item.path, latestSnapshotVersion)) {
        continue;
      }
      try {
        const bytes = await getThumbnailBytes(item.path);
        await putCachedThumbnail(
          item.path,
          latestSnapshotVersion,
          new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" }),
        );
      } catch {
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export async function getCachedLocalLibraryItems(
  libraryId: string,
): Promise<LibraryImage[]> {
  if (await isTauriRuntime()) {
    return tauriLocalLibraryListings.get(libraryId)?.items ?? [];
  }
  return (await loadLocalLibraryListing(libraryId)).items;
}

export async function loadLocalLibraryItemsCachedOrRemote(
  libraryId: string,
): Promise<LibraryImageListing> {
  if (await isTauriRuntime()) {
    const listing = normalizeLibraryImageListing(await listLibraryImages(libraryId));
    tauriLocalLibraryListings.set(libraryId, listing);
    void warmLocalLibraryThumbnails(listing.items);
    return listing;
  }
  try {
    const listing = normalizeLibraryImageListing(await listLibraryImages(libraryId));
    await saveLocalLibraryListing(libraryId, listing);
    void warmLocalLibraryThumbnails(listing.items);
    return listing;
  } catch (error) {
    const cachedListing = await loadLocalLibraryListing(libraryId);
    if (cachedListing.items.length > 0) {
      return cachedListing;
    }
    throw error;
  }
}

export async function resolveLocalThumbnailSrc(
  path: string,
  latestSnapshotVersion: number | null,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  const key = thumbnailKey(path, latestSnapshotVersion);
  const cached = await getCachedThumbnail(path, latestSnapshotVersion);
  if (cached) {
    return URL.createObjectURL(cached);
  }
  const recentFailure = failedThumbnailLoads.get(key);
  if (recentFailure && recentFailure.retryAt > Date.now()) {
    throw recentFailure.error;
  }
  const bytes = await getThumbnailBytes(path).catch((error) => {
    failedThumbnailLoads.set(key, {
      error,
      retryAt: Date.now() + FAILURE_COOLDOWN_MS,
    });
    throw error;
  });
  if (signal.aborted) {
    throw abortError();
  }
  const blob = new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" });
  await putCachedThumbnail(path, latestSnapshotVersion, blob);
  failedThumbnailLoads.delete(key);
  return URL.createObjectURL(blob);
}

export function resetLocalThumbnailFailure(path: string) {
  for (const key of failedThumbnailLoads.keys()) {
    if (key.startsWith(`${path}::snapshot:`)) {
      failedThumbnailLoads.delete(key);
    }
  }
}
