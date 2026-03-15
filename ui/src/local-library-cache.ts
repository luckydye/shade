import {
  getThumbnailBytes,
  listLibraryImages,
  type LibraryImage,
  type LibraryImageListing,
} from "./bridge/index";

const DB_NAME = "shade-local-library-cache";
const DB_VERSION = 1;
const LIBRARIES_STORE = "libraries";
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";
const FAILURE_COOLDOWN_MS = 5_000;

type CachedFailures = Map<string, { error: unknown; retryAt: number }>;

type CachedLocalLibrary = {
  is_complete: boolean;
};

type CachedLocalItem = {
  libraryId: string;
  path: string;
  name: string;
  modified_at: number | null;
  has_snapshots: boolean;
};

const failedThumbnailLoads: CachedFailures = new Map();

function normalizeModifiedAt(modifiedAt: unknown) {
  return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
    ? modifiedAt
    : null;
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
  };
}

function toLibraryImage(item: CachedLocalItem): LibraryImage {
  return {
    path: item.path,
    name: item.name,
    modified_at: normalizeModifiedAt(item.modified_at),
    metadata: {
      has_snapshots: item.has_snapshots,
    },
  };
}

function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
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

function localItemKey(libraryId: string, path: string) {
  return `${libraryId}:${path}`;
}

async function loadLocalLibraryListing(libraryId: string): Promise<LibraryImageListing> {
  return withStores([LIBRARIES_STORE, ITEMS_STORE], "readonly", async (stores) => {
    const library = (await requestToPromise(stores[LIBRARIES_STORE].get(libraryId))) as
      | CachedLocalLibrary
      | undefined;
    const result = await requestToPromise(stores[ITEMS_STORE].getAll());
    const items = Array.isArray(result)
      ? result
          .map((item) => item as CachedLocalItem)
          .filter((item) => item.libraryId === libraryId)
          .map(toLibraryImage)
      : [];
    return {
      items,
      is_complete: library?.is_complete ?? false,
    };
  });
}

async function saveLocalLibraryListing(
  libraryId: string,
  listing: LibraryImageListing,
): Promise<void> {
  await withStores([LIBRARIES_STORE, ITEMS_STORE], "readwrite", async (stores) => {
    await requestToPromise(
      stores[LIBRARIES_STORE].put(
        { is_complete: listing.is_complete } satisfies CachedLocalLibrary,
        libraryId,
      ),
    );
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

async function getCachedThumbnail(path: string): Promise<Blob | null> {
  return withStores([THUMBNAILS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[THUMBNAILS_STORE].get(path));
    return result instanceof Blob ? result : null;
  });
}

async function putCachedThumbnail(path: string, blob: Blob): Promise<void> {
  await withStores([THUMBNAILS_STORE], "readwrite", async (stores) => {
    await requestToPromise(stores[THUMBNAILS_STORE].put(blob, path));
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
      if (await getCachedThumbnail(item.path)) {
        continue;
      }
      try {
        const bytes = await getThumbnailBytes(item.path);
        await putCachedThumbnail(
          item.path,
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
  return (await loadLocalLibraryListing(libraryId)).items;
}

export async function loadLocalLibraryItemsCachedOrRemote(
  libraryId: string,
): Promise<LibraryImageListing> {
  try {
    const listing = await listLibraryImages(libraryId);
    await saveLocalLibraryListing(libraryId, listing);
    void warmLocalLibraryThumbnails(listing.items);
    return {
      items: listing.items.map(normalizeLibraryImage),
      is_complete: listing.is_complete,
    };
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
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  const cached = await getCachedThumbnail(path);
  if (cached) {
    return URL.createObjectURL(cached);
  }
  const recentFailure = failedThumbnailLoads.get(path);
  if (recentFailure && recentFailure.retryAt > Date.now()) {
    throw recentFailure.error;
  }
  const bytes = await getThumbnailBytes(path).catch((error) => {
    failedThumbnailLoads.set(path, {
      error,
      retryAt: Date.now() + FAILURE_COOLDOWN_MS,
    });
    throw error;
  });
  if (signal.aborted) {
    throw abortError();
  }
  const blob = new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" });
  await putCachedThumbnail(path, blob);
  failedThumbnailLoads.delete(path);
  return URL.createObjectURL(blob);
}

export function resetLocalThumbnailFailure(path: string) {
  failedThumbnailLoads.delete(path);
}
