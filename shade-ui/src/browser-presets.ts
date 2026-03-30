import type {
  AdjustmentValues,
  CropValues,
  MaskParamsInfo,
  PresetInfo,
} from "./bridge/index";
import { requestToPromise } from "./cache-utils";

const DB_NAME = "shade-browser-presets";
const DB_VERSION = 1;
const PRESETS_STORE = "presets";

export interface BrowserPresetLayer {
  kind: "adjustment" | "crop";
  name: string | null;
  visible: boolean;
  opacity: number;
  adjustments: AdjustmentValues | null;
  crop: CropValues | null;
  mask_params: MaskParamsInfo | null;
}

export interface BrowserPresetFile {
  version: number;
  layers: BrowserPresetLayer[];
}

type BrowserPresetRecord = {
  name: string;
  file: BrowserPresetFile;
};

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser presets");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PRESETS_STORE)) {
        db.createObjectStore(PRESETS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction([PRESETS_STORE], mode);
  const store = tx.objectStore(PRESETS_STORE);
  try {
    const result = await run(store);
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

function normalizePresetName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("preset name cannot be empty");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("preset name contains invalid path characters");
  }
  return trimmed;
}

function assertPresetFile(file: BrowserPresetFile, name: string): BrowserPresetFile {
  if (file.version !== 1) {
    throw new Error(`unsupported preset version: ${file.version}`);
  }
  if (!Array.isArray(file.layers)) {
    throw new Error(`invalid preset file: ${name}`);
  }
  return file;
}

export async function listBrowserPresets(): Promise<PresetInfo[]> {
  const records = await withStore("readonly", async (store) => {
    const result = await requestToPromise(store.getAll());
    if (!Array.isArray(result)) {
      throw new Error("preset store returned an invalid result");
    }
    return result as BrowserPresetRecord[];
  });
  return records
    .map((record) => ({ name: normalizePresetName(record.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveBrowserPreset(
  name: string,
  file: BrowserPresetFile,
): Promise<PresetInfo> {
  const normalizedName = normalizePresetName(name);
  assertPresetFile(file, normalizedName);
  await withStore("readwrite", async (store) => {
    await requestToPromise(
      store.put(
        {
          name: normalizedName,
          file,
        } satisfies BrowserPresetRecord,
        normalizedName,
      ),
    );
  });
  return { name: normalizedName };
}

export async function renameBrowserPreset(
  oldName: string,
  newName: string,
): Promise<PresetInfo> {
  const normalizedOld = normalizePresetName(oldName);
  const normalizedNew = normalizePresetName(newName);
  if (normalizedOld === normalizedNew) {
    return { name: normalizedOld };
  }
  return withStore("readwrite", async (store) => {
    const result = await requestToPromise(store.get(normalizedOld));
    if (typeof result !== "object" || result === null) {
      throw new Error(`preset not found: ${normalizedOld}`);
    }
    const record = result as Partial<BrowserPresetRecord>;
    if (!record.file) {
      throw new Error(`invalid preset record: ${normalizedOld}`);
    }
    await requestToPromise(
      store.put(
        { name: normalizedNew, file: record.file } satisfies BrowserPresetRecord,
        normalizedNew,
      ),
    );
    await requestToPromise(store.delete(normalizedOld));
    return { name: normalizedNew };
  });
}

export async function loadBrowserPreset(name: string): Promise<BrowserPresetFile> {
  const normalizedName = normalizePresetName(name);
  const result = await withStore("readonly", async (store) =>
    requestToPromise(store.get(normalizedName)),
  );
  if (typeof result !== "object" || result === null) {
    throw new Error(`preset not found: ${normalizedName}`);
  }
  const record = result as Partial<BrowserPresetRecord>;
  if (record.name !== normalizedName || typeof record.file !== "object" || !record.file) {
    throw new Error(`invalid preset file: ${normalizedName}`);
  }
  return assertPresetFile(record.file, normalizedName);
}
