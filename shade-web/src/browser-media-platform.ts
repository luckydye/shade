import type {
  BrowserDirectoryHandle,
  BrowserFileHandle,
  BrowserMediaPlatform,
  LibraryImage,
  LibraryImageListing,
  MediaLibrary,
} from "shade-ui/src/bridge/index";
import { getBrowserPlatform } from "shade-ui/src/bridge/index";
import {
  fileNameFromPath,
  loadBrowserEncodedBytes,
  loadBrowserThumbnailBytes,
} from "./browser-image-preview";
import { requestToPromise, withStores } from "./indexed-db";

const DB_NAME = "shade-browser-media-library";
const DB_VERSION = 1;
const LIBRARIES_STORE = "libraries";
const ITEMS_STORE = "items";
const LIBRARY_ID_PREFIX = "browser-directory:";
const ITEM_PATH_PREFIX = "browser-library://";
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".avif",
  ".exr",
  ".3fr",
  ".ari",
  ".arw",
  ".cr2",
  ".cr3",
  ".crm",
  ".crw",
  ".dcr",
  ".dcs",
  ".dng",
  ".erf",
  ".fff",
  ".iiq",
  ".kdc",
  ".mef",
  ".mos",
  ".mrw",
  ".nef",
  ".nrw",
  ".orf",
  ".ori",
  ".pef",
  ".qtk",
  ".raf",
  ".raw",
  ".rw2",
  ".rwl",
  ".srw",
  ".x3f",
]);
const MOUNTED_IMAGE_PERMISSION_ERROR =
  "read permission is required to open this mounted image";

type BrowserMediaLibraryRecord = {
  id: string;
  name: string;
  path: string | null;
  rootHandle: BrowserDirectoryHandle;
};

type BrowserMediaItemRecord = {
  libraryId: string;
  path: string;
  relativePath: string;
  name: string;
  modified_at: number | null;
  fileHandle: BrowserFileHandle;
};

const libraryRecordCache = new Map<string, BrowserMediaLibraryRecord>();

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser media libraries");
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
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function isDirectoryHandle(value: unknown): value is BrowserDirectoryHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "directory"
  );
}

function assertDirectoryPicker() {
  if (typeof directoryPicker() !== "function") {
    throw new Error("showDirectoryPicker is unavailable in this browser");
  }
}

function directoryPicker() {
  return (
    globalThis as typeof globalThis & {
      showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
    }
  ).showDirectoryPicker;
}

async function ensureReadPermission(handle: BrowserFileSystemHandle) {
  const permission = await handle.requestPermission({ mode: "read" });
  if (permission !== "granted") {
    throw new Error("read permission is required to mount this folder");
  }
}

async function assertReadable(handle: BrowserFileSystemHandle) {
  const permission = await handle.queryPermission({ mode: "read" });
  if (permission !== "granted") {
    throw new Error("mounted folder permission is no longer granted");
  }
}

function libraryId() {
  if (typeof crypto.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required for browser media libraries");
  }
  return `${LIBRARY_ID_PREFIX}${crypto.randomUUID()}`;
}

function itemKey(path: string) {
  return path;
}

function itemPath(libraryId: string, relativePath: string) {
  return `${ITEM_PATH_PREFIX}${libraryId}/${relativePath}`;
}

function parseItemPath(path: string) {
  if (!path.startsWith(ITEM_PATH_PREFIX)) {
    throw new Error(`invalid browser media item path: ${path}`);
  }
  const suffix = path.slice(ITEM_PATH_PREFIX.length);
  const slashIdx = suffix.indexOf("/");
  if (slashIdx <= 0) {
    throw new Error(`invalid browser media item path: ${path}`);
  }
  return {
    libraryId: suffix.slice(0, slashIdx),
    relativePath: suffix.slice(slashIdx + 1),
  };
}

function toMediaLibrary(record: BrowserMediaLibraryRecord): MediaLibrary {
  return {
    id: record.id,
    name: record.name,
    kind: "directory",
    mode: "browse",
    path: record.path,
    removable: true,
    readonly: true,
  };
}

function toLibraryImage(
  record: BrowserMediaItemRecord,
  snapshotMap: Map<string, string>,
): LibraryImage {
  const latestSnapshotId = snapshotMap.get(record.path) ?? null;
  return {
    path: record.path,
    name: record.name,
    modified_at: record.modified_at,
    file_hash: null,
    metadata: {
      has_snapshots: latestSnapshotId !== null,
      latest_snapshot_id: latestSnapshotId,
      rating: null,
      tags: [],
    },
  };
}

function cacheLibraryRecord(record: BrowserMediaLibraryRecord) {
  libraryRecordCache.set(record.id, record);
  return record;
}

function clearCachedLibraryRecord(id: string) {
  libraryRecordCache.delete(id);
}

function isSupportedImageFile(name: string) {
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(name.slice(dotIdx).toLowerCase());
}

async function listLibraryRecords(): Promise<BrowserMediaLibraryRecord[]> {
  return withStores(openDb, [LIBRARIES_STORE], "readonly", async (stores) => {
    const records = await requestToPromise(stores[LIBRARIES_STORE].getAll());
    if (!Array.isArray(records)) {
      return [];
    }
    return (records as BrowserMediaLibraryRecord[]).map(cacheLibraryRecord);
  });
}

async function getLibraryRecord(
  id: string,
): Promise<BrowserMediaLibraryRecord | null> {
  const cached = libraryRecordCache.get(id);
  if (cached) {
    return cached;
  }
  return withStores(openDb, [LIBRARIES_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[LIBRARIES_STORE].get(id));
    return result ? cacheLibraryRecord(result as BrowserMediaLibraryRecord) : null;
  });
}

async function getItemRecord(path: string): Promise<BrowserMediaItemRecord | null> {
  return withStores(openDb, [ITEMS_STORE], "readonly", async (stores) => {
    const result = await requestToPromise(stores[ITEMS_STORE].get(itemKey(path)));
    return result ? (result as BrowserMediaItemRecord) : null;
  });
}

async function findExistingLibrary(
  handle: BrowserDirectoryHandle,
): Promise<BrowserMediaLibraryRecord | null> {
  const records = await listLibraryRecords();
  for (const record of records) {
    if (await record.rootHandle.isSameEntry(handle)) {
      return record;
    }
  }
  return null;
}

async function scanDirectory(
  rootHandle: BrowserDirectoryHandle,
  rootId: string,
): Promise<BrowserMediaItemRecord[]> {
  const items: BrowserMediaItemRecord[] = [];

  async function visitDirectory(
    handle: BrowserDirectoryHandle,
    segments: string[],
  ): Promise<void> {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        await visitDirectory(entry, [...segments, entry.name]);
        continue;
      }
      if (!isSupportedImageFile(entry.name)) {
        continue;
      }
      const relativePath = [...segments, entry.name].join("/");
      const file = await entry.getFile();
      items.push({
        libraryId: rootId,
        path: itemPath(rootId, relativePath),
        relativePath,
        name: entry.name,
        modified_at: Number.isFinite(file.lastModified) ? file.lastModified : null,
        fileHandle: entry,
      });
    }
  }

  await visitDirectory(rootHandle, []);
  items.sort((a, b) => {
    const left = a.modified_at ?? 0;
    const right = b.modified_at ?? 0;
    return right - left || a.relativePath.localeCompare(b.relativePath);
  });
  return items;
}

async function replaceLibraryItems(
  library: BrowserMediaLibraryRecord,
  items: BrowserMediaItemRecord[],
) {
  await withStores(openDb, [LIBRARIES_STORE, ITEMS_STORE], "readwrite", async (stores) => {
    await requestToPromise(stores[LIBRARIES_STORE].put(library, library.id));
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(itemPath(library.id, "")))
        .map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
    await Promise.all(
      items.map((item) =>
        requestToPromise(stores[ITEMS_STORE].put(item, itemKey(item.path))),
      ),
    );
  });
  cacheLibraryRecord(library);
}

function normalizeMountedImageAccessError(error: unknown): Error {
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  ) {
    return new Error(MOUNTED_IMAGE_PERMISSION_ERROR);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function loadItemFile(path: string): Promise<File> {
  const cached = await getItemRecord(path);
  if (cached) {
    try {
      return await cached.fileHandle.getFile();
    } catch (error) {
      throw normalizeMountedImageAccessError(error);
    }
  }
  const parsed = parseItemPath(path);
  const listing = await listBrowserLibraryImages(parsed.libraryId);
  const item = listing.items.find((entry) => entry.path === path);
  if (!item) {
    throw new Error(`mounted media item not found: ${path}`);
  }
  const refreshed = await getItemRecord(path);
  if (!refreshed) {
    throw new Error(`mounted media item handle missing after refresh: ${path}`);
  }
  try {
    return await refreshed.fileHandle.getFile();
  } catch (error) {
    throw normalizeMountedImageAccessError(error);
  }
}

async function pickBrowserDirectory(): Promise<BrowserDirectoryHandle | null> {
  assertDirectoryPicker();
  try {
    const pick = directoryPicker();
    if (!pick) {
      throw new Error("showDirectoryPicker is unavailable in this browser");
    }
    return await pick();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

async function listBrowserMediaLibraries(): Promise<MediaLibrary[]> {
  return (await listLibraryRecords()).map(toMediaLibrary);
}

async function addBrowserMediaLibrary(
  selection: BrowserDirectoryHandle,
): Promise<MediaLibrary> {
  if (!isDirectoryHandle(selection)) {
    throw new Error("expected a directory handle");
  }
  await ensureReadPermission(selection);
  const existing = await findExistingLibrary(selection);
  if (existing) {
    return toMediaLibrary(existing);
  }
  const record: BrowserMediaLibraryRecord = {
    id: libraryId(),
    name: selection.name,
    path: selection.name,
    rootHandle: selection,
  };
  const items = await scanDirectory(selection, record.id);
  await replaceLibraryItems(record, items);
  return toMediaLibrary(cacheLibraryRecord(record));
}

async function removeBrowserMediaLibrary(id: string): Promise<void> {
  await withStores(openDb, [LIBRARIES_STORE, ITEMS_STORE], "readwrite", async (stores) => {
    await requestToPromise(stores[LIBRARIES_STORE].delete(id));
    const keys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && key.startsWith(itemPath(id, "")))
        .map((key) => requestToPromise(stores[ITEMS_STORE].delete(key))),
    );
  });
  clearCachedLibraryRecord(id);
}

async function listBrowserLibraryImages(
  libraryId: string,
): Promise<LibraryImageListing> {
  const library = await getLibraryRecord(libraryId);
  if (!library) {
    throw new Error(`mounted library not found: ${libraryId}`);
  }
  await assertReadable(library.rootHandle);
  const [items, snapshotMap] = await Promise.all([
    scanDirectory(library.rootHandle, library.id),
    getBrowserPlatform().snapshots.getSnapshotPathMap(),
  ]);
  await replaceLibraryItems(library, items);
  return {
    items: items.map((item) => toLibraryImage(item, snapshotMap)),
    is_complete: true,
  };
}

function isBrowserMountedPath(path: string): boolean {
  return path.startsWith(ITEM_PATH_PREFIX);
}

function requestBrowserMountedImageReadPermission(path: string): Promise<void> {
  const { libraryId } = parseItemPath(path);
  const library = libraryRecordCache.get(libraryId);
  if (!library) {
    throw new Error(`mounted library not loaded: ${libraryId}`);
  }
  return library.rootHandle
    .requestPermission({ mode: "read" })
    .then((permission) => {
      if (permission !== "granted") {
        throw new Error(MOUNTED_IMAGE_PERMISSION_ERROR);
      }
    })
    .catch((error) => {
      throw normalizeMountedImageAccessError(error);
    });
}

async function fetchFile(path: string): Promise<Blob> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`failed to fetch ${path}: ${response.status}`);
  }
  return response.blob();
}

export const browserMediaPlatform: BrowserMediaPlatform & {
  getThumbnailBytes(path: string): Promise<Uint8Array>;
} = {
  pickDirectory: pickBrowserDirectory,
  listMediaLibraries: listBrowserMediaLibraries,
  listLibraryImages: listBrowserLibraryImages,
  addMediaLibrary: addBrowserMediaLibrary,
  removeMediaLibrary: removeBrowserMediaLibrary,
  prepareImageOpen(path) {
    if (!isBrowserMountedPath(path)) {
      return Promise.resolve();
    }
    return requestBrowserMountedImageReadPermission(path);
  },
  async getImageSource(path) {
    if (isBrowserMountedPath(path)) {
      const file = await loadItemFile(path);
      return loadBrowserEncodedBytes(file.name, file);
    }
    return loadBrowserEncodedBytes(fileNameFromPath(path), await fetchFile(path));
  },
  getImageFileSource(file, fileName) {
    return loadBrowserEncodedBytes(fileName, file);
  },
  async getThumbnailBytes(path) {
    if (isBrowserMountedPath(path)) {
      const file = await loadItemFile(path);
      return loadBrowserThumbnailBytes(file.name, file);
    }
    return loadBrowserThumbnailBytes(fileNameFromPath(path), await fetchFile(path));
  },
};
