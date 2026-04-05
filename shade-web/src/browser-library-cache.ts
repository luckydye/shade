import type {
  LibraryCachePlatform,
  LibraryImage,
  LibraryImageListing,
  SharedPicture,
} from "shade-ui/src/bridge/index";
import {
  normalizeModifiedAt,
  normalizeRating,
  normalizeTags,
} from "shade-ui/src/cache-utils";
import { browserMediaPlatform } from "./browser-media-platform";
import { requestToPromise, withStores } from "./indexed-db";

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
  file_hash: string | null;
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
  rating: number | null;
  tags: string[];
};

const failedThumbnailLoads: CachedFailures = new Map();

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

function unsupported(message: string): never {
  throw new Error(message);
}

function normalizeSnapshotVersion(version: unknown) {
  return typeof version === "string" && version.length > 0 ? version : null;
}

function normalizeLibraryImage(image: LibraryImage): LibraryImage {
  return {
    path: image.path,
    name: image.name,
    modified_at: normalizeModifiedAt(
      (image as LibraryImage & { modified_at?: unknown }).modified_at,
    ),
    file_hash:
      typeof image.file_hash === "string" && image.file_hash.length > 0
        ? image.file_hash
        : null,
    metadata: {
      has_snapshots: image.metadata?.has_snapshots ?? false,
      latest_snapshot_id: normalizeSnapshotVersion(
        image.metadata?.latest_snapshot_id,
      ),
      rating: normalizeRating(image.metadata?.rating),
      tags: normalizeTags(image.metadata?.tags),
    },
  };
}

function toCachedLocalItem(libraryId: string, image: LibraryImage): CachedLocalItem {
  return {
    libraryId,
    path: image.path,
    name: image.name,
    modified_at: normalizeModifiedAt(image.modified_at),
    file_hash:
      typeof image.file_hash === "string" && image.file_hash.length > 0
        ? image.file_hash
        : null,
    has_snapshots: image.metadata?.has_snapshots ?? false,
    latest_snapshot_id: normalizeSnapshotVersion(
      image.metadata?.latest_snapshot_id,
    ),
    rating: normalizeRating(image.metadata?.rating),
    tags: normalizeTags(image.metadata?.tags),
  };
}

function toLibraryImage(item: CachedLocalItem): LibraryImage {
  return {
    path: item.path,
    name: item.name,
    modified_at: normalizeModifiedAt(item.modified_at),
    file_hash:
      typeof item.file_hash === "string" && item.file_hash.length > 0
        ? item.file_hash
        : null,
    metadata: {
      has_snapshots: item.has_snapshots,
      latest_snapshot_id: normalizeSnapshotVersion(item.latest_snapshot_id),
      rating: normalizeRating(item.rating),
      tags: normalizeTags(item.tags),
    },
  };
}

function normalizeLibraryImageListing(listing: LibraryImageListing): LibraryImageListing {
  return {
    items: listing.items.map(normalizeLibraryImage),
    is_complete: listing.is_complete,
  };
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser local library caching");
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

function localItemKey(libraryId: string, path: string) {
  return `${libraryId}:${path}`;
}

async function loadLocalLibraryListing(libraryId: string): Promise<LibraryImageListing> {
  return withStores(openDb, [ITEMS_STORE], "readonly", async (stores) => {
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
  await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
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

function thumbnailKey(path: string, latestSnapshotId: string | null) {
  return `${path}::snapshot:${latestSnapshotId ?? "none"}`;
}

async function getCachedThumbnail(
  path: string,
  latestSnapshotId: string | null,
): Promise<Blob | null> {
  return withStores(openDb, [THUMBNAILS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(
      stores[THUMBNAILS_STORE].get(thumbnailKey(path, latestSnapshotId)),
    );
    return result instanceof Blob ? result : null;
  });
}

async function putCachedThumbnail(
  path: string,
  latestSnapshotId: string | null,
  blob: Blob,
): Promise<void> {
  await withStores(openDb, [THUMBNAILS_STORE], "readwrite", async (stores) => {
    await requestToPromise(
      stores[THUMBNAILS_STORE].put(blob, thumbnailKey(path, latestSnapshotId)),
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
      const latestSnapshotId = normalizeSnapshotVersion(
        item.metadata?.latest_snapshot_id,
      );
      if (await getCachedThumbnail(item.path, latestSnapshotId)) {
        continue;
      }
      try {
        const bytes = await browserMediaPlatform.getThumbnailBytes(item.path);
        await putCachedThumbnail(
          item.path,
          latestSnapshotId,
          new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" }),
        );
      } catch {
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export const browserLibraryCache: LibraryCachePlatform = {
  async getCachedLocalLibraryItems(libraryId) {
    return (await loadLocalLibraryListing(libraryId)).items;
  },
  async loadLocalLibraryItemsCachedOrRemote(libraryId) {
    try {
      const listing = normalizeLibraryImageListing(
        await browserMediaPlatform.listLibraryImages(libraryId),
      );
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
  },
  getCachedCameraLibraryItems() {
    unsupported("camera libraries are not implemented in the browser runtime");
  },
  loadCameraLibraryItemsCachedOrRemote() {
    unsupported("camera libraries are not implemented in the browser runtime");
  },
  getCachedPeerLibraryItems() {
    unsupported("peer libraries are not implemented in the browser runtime");
  },
  loadPeerLibraryItemsCachedOrRemote() {
    unsupported("peer libraries are not implemented in the browser runtime");
  },
  removePeerLibrary() {
    unsupported("peer libraries are not implemented in the browser runtime");
  },
  async resolveLocalThumbnailSrc(path, latestSnapshotId, signal) {
    if (signal.aborted) {
      throw abortError();
    }
    const key = thumbnailKey(path, latestSnapshotId);
    const cached = await getCachedThumbnail(path, latestSnapshotId);
    if (cached) {
      return URL.createObjectURL(cached);
    }
    const recentFailure = failedThumbnailLoads.get(key);
    if (recentFailure && recentFailure.retryAt > Date.now()) {
      throw recentFailure.error;
    }
    const bytes = await browserMediaPlatform.getThumbnailBytes(path).catch((error) => {
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
    await putCachedThumbnail(path, latestSnapshotId, blob);
    failedThumbnailLoads.delete(key);
    return URL.createObjectURL(blob);
  },
  resolveCameraThumbnailSrc() {
    unsupported("camera libraries are not implemented in the browser runtime");
  },
  resolvePeerThumbnailSrc() {
    unsupported("peer libraries are not implemented in the browser runtime");
  },
  resetLocalThumbnailFailure(path) {
    for (const key of failedThumbnailLoads.keys()) {
      if (key.startsWith(`${path}::snapshot:`)) {
        failedThumbnailLoads.delete(key);
      }
    }
  },
  resetCameraThumbnailFailure() {},
};
