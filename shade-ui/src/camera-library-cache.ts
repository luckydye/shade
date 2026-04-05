import { getThumbnailBackend } from "./bridge/thumbnail-backend";
import { listLibraryImages, type LibraryImage } from "./bridge/index";
import {
  abortError,
  normalizeModifiedAt,
  normalizeRating,
  normalizeTags,
  requestToPromise,
  toBlobBuffer,
  withStores,
} from "./cache-utils";

const DB_NAME = "shade-camera-cache";
const DB_VERSION = 2;
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";
const FAILURE_COOLDOWN_MS = 5_000;

type CachedFailures = Map<string, { error: unknown; retryAt: number }>;

const failedThumbnailLoads: CachedFailures = new Map();

type CachedCameraItem = {
  contentKey: string;
  name: string;
  modified_at: number | null;
  file_hash: string | null;
  has_snapshots: boolean;
  latest_snapshot_id: string | null;
  rating: number | null;
  tags: string[];
};

function cameraContentKey(path: string) {
  if (!path.startsWith("ccapi://")) {
    return path;
  }
  const withoutScheme = path.slice("ccapi://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) {
    return path;
  }
  return withoutScheme.slice(slashIndex);
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

function toCachedCameraItem(image: LibraryImage): CachedCameraItem {
  return {
    contentKey: cameraContentKey(image.path),
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

function toLibraryImage(host: string, item: CachedCameraItem): LibraryImage {
  return {
    path: `ccapi://${host}${item.contentKey}`,
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

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for camera caching");
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
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function loadCameraLibraryItems(host: string) {
  return withStores(openDb, [ITEMS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[ITEMS_STORE].getAll());
    return Array.isArray(result)
      ? result
          .map((item) => item as CachedCameraItem)
          .map((item) => toLibraryImage(host, item))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
  });
}

async function saveCameraLibraryItems(items: LibraryImage[]) {
  await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys.map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
    await Promise.all(
      items
        .map(normalizeLibraryImage)
        .map(toCachedCameraItem)
        .map((item) => requestToPromise(stores[ITEMS_STORE].put(item, item.contentKey))),
    );
  });
}

function thumbnailKeyWithVersion(
  path: string,
  latestSnapshotId: string | null,
) {
  return `${cameraContentKey(path)}::snapshot:${latestSnapshotId ?? "none"}`;
}

async function getCachedThumbnail(
  path: string,
  latestSnapshotId: string | null,
): Promise<Blob | null> {
  return withStores(openDb, [THUMBNAILS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(
      stores[THUMBNAILS_STORE].get(
        thumbnailKeyWithVersion(path, latestSnapshotId),
      ),
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
      stores[THUMBNAILS_STORE].put(
        blob,
        thumbnailKeyWithVersion(path, latestSnapshotId),
      ),
    );
  });
}

async function warmCameraLibraryThumbnails(items: LibraryImage[]) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      const latestSnapshotId = normalizeSnapshotVersion(
        item.metadata?.latest_snapshot_id,
      );
      if (await getCachedThumbnail(item.path, latestSnapshotId)) {
        continue;
      }
      try {
        const bytes = await getThumbnailBackend().getThumbnailBytes(item.path);
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

  await worker();
}

export async function getCachedCameraLibraryItems(host: string): Promise<LibraryImage[]> {
  return loadCameraLibraryItems(host);
}

export async function loadCameraLibraryItemsCachedOrRemote(
  host: string,
): Promise<LibraryImage[]> {
  try {
    const listing = await listLibraryImages(`ccapi:${host}`);
    await saveCameraLibraryItems(listing.items);
    void warmCameraLibraryThumbnails(listing.items);
    return listing.items.map(normalizeLibraryImage);
  } catch (error) {
    const cachedItems = await loadCameraLibraryItems(host);
    if (cachedItems.length > 0) {
      return cachedItems;
    }
    throw error;
  }
}

export async function resolveCameraThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  const failureKey = thumbnailKeyWithVersion(path, latestSnapshotId);
  const cached = await getCachedThumbnail(path, latestSnapshotId);
  if (cached) {
    return URL.createObjectURL(cached);
  }
  const recentFailure = failedThumbnailLoads.get(failureKey);
  if (recentFailure && recentFailure.retryAt > Date.now()) {
    throw recentFailure.error;
  }
  const bytes = await getThumbnailBackend().getThumbnailBytes(path).catch((error) => {
    failedThumbnailLoads.set(failureKey, {
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
  failedThumbnailLoads.delete(failureKey);
  return URL.createObjectURL(blob);
}

export function resetCameraThumbnailFailure(path: string) {
  for (const key of failedThumbnailLoads.keys()) {
    if (key.startsWith(`${cameraContentKey(path)}::snapshot:`)) {
      failedThumbnailLoads.delete(key);
    }
  }
}
