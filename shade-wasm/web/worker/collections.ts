import type { Collection, CollectionItem } from "shade-ui/src/bridge/types";
import { requestToPromise, withStores } from "../indexed-db";

interface CollectionsHandlers {
  listCollections(libraryId: string): Promise<Collection[]>;
  createCollection(libraryId: string, name: string): Promise<Collection>;
  renameCollection(collectionId: string, name: string): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  reorderCollection(collectionId: string, newPosition: number): Promise<void>;
  listCollectionItems(collectionId: string): Promise<CollectionItem[]>;
  addToCollection(collectionId: string, fingerprints: string[]): Promise<void>;
  removeFromCollection(collectionId: string, fingerprints: string[]): Promise<void>;
}

const DB_NAME = "shade-browser-collections";
const DB_VERSION = 2;
const COLLECTIONS_STORE = "collections";
const ITEMS_STORE = "collection_items";

type CollectionRecord = {
  id: string;
  library_id: string;
  name: string;
  position: number;
  created_at: number;
};

type CollectionItemRecord = {
  collection_id: string;
  fingerprint: string;
  position: number;
  added_at: number;
};

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser collections");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COLLECTIONS_STORE)) {
        db.createObjectStore(COLLECTIONS_STORE);
      }
      if (db.objectStoreNames.contains(ITEMS_STORE)) {
        db.deleteObjectStore(ITEMS_STORE);
      }
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function collectionKey(id: string) {
  return id;
}

function itemKey(collectionId: string, fingerprint: string) {
  return `${collectionId}::${fingerprint}`;
}

async function countItems(
  stores: Record<string, IDBObjectStore>,
  collectionId: string,
): Promise<number> {
  const all = await requestToPromise(stores[ITEMS_STORE].getAll());
  return (all as CollectionItemRecord[]).filter((r) => r.collection_id === collectionId)
    .length;
}

export const browserCollectionsPlatform: CollectionsHandlers = {
  async listCollections(libraryId) {
    return withStores(
      openDb,
      [COLLECTIONS_STORE, ITEMS_STORE],
      "readonly",
      async (stores) => {
        const all = await requestToPromise(stores[COLLECTIONS_STORE].getAll());
        const records = (all as CollectionRecord[]).filter(
          (r) => r.library_id === libraryId,
        );
        records.sort((a, b) => a.position - b.position || a.created_at - b.created_at);
        const allItems = await requestToPromise(stores[ITEMS_STORE].getAll());
        const itemsByCollection = new Map<string, number>();
        for (const item of allItems as CollectionItemRecord[]) {
          itemsByCollection.set(
            item.collection_id,
            (itemsByCollection.get(item.collection_id) ?? 0) + 1,
          );
        }
        return records.map((r) => ({
          ...r,
          item_count: itemsByCollection.get(r.id) ?? 0,
        }));
      },
    );
  },

  async createCollection(libraryId, name) {
    const id = crypto.randomUUID();
    const now = Date.now();
    return withStores(openDb, [COLLECTIONS_STORE], "readwrite", async (stores) => {
      const all = await requestToPromise(stores[COLLECTIONS_STORE].getAll());
      const siblings = (all as CollectionRecord[]).filter(
        (r) => r.library_id === libraryId,
      );
      const maxPos = siblings.reduce((m, r) => Math.max(m, r.position), -1);
      const record: CollectionRecord = {
        id,
        library_id: libraryId,
        name,
        position: maxPos + 1,
        created_at: now,
      };
      await requestToPromise(stores[COLLECTIONS_STORE].put(record, collectionKey(id)));
      return { ...record, item_count: 0 };
    });
  },

  async renameCollection(collectionId, name) {
    await withStores(openDb, [COLLECTIONS_STORE], "readwrite", async (stores) => {
      const record = (await requestToPromise(
        stores[COLLECTIONS_STORE].get(collectionKey(collectionId)),
      )) as CollectionRecord | undefined;
      if (!record) throw new Error(`collection not found: ${collectionId}`);
      record.name = name;
      await requestToPromise(
        stores[COLLECTIONS_STORE].put(record, collectionKey(collectionId)),
      );
    });
  },

  async deleteCollection(collectionId) {
    await withStores(
      openDb,
      [COLLECTIONS_STORE, ITEMS_STORE],
      "readwrite",
      async (stores) => {
        await requestToPromise(
          stores[COLLECTIONS_STORE].delete(collectionKey(collectionId)),
        );
        const allKeys = await requestToPromise(stores[ITEMS_STORE].getAllKeys());
        const prefix = `${collectionId}::`;
        await Promise.all(
          allKeys
            .filter((k) => typeof k === "string" && k.startsWith(prefix))
            .map((k) => requestToPromise(stores[ITEMS_STORE].delete(k))),
        );
      },
    );
  },

  async reorderCollection(collectionId, newPosition) {
    await withStores(openDb, [COLLECTIONS_STORE], "readwrite", async (stores) => {
      const record = (await requestToPromise(
        stores[COLLECTIONS_STORE].get(collectionKey(collectionId)),
      )) as CollectionRecord | undefined;
      if (!record) throw new Error(`collection not found: ${collectionId}`);
      record.position = newPosition;
      await requestToPromise(
        stores[COLLECTIONS_STORE].put(record, collectionKey(collectionId)),
      );
    });
  },

  async listCollectionItems(collectionId) {
    return withStores(openDb, [ITEMS_STORE], "readonly", async (stores) => {
      const all = await requestToPromise(stores[ITEMS_STORE].getAll());
      const items = (all as CollectionItemRecord[])
        .filter((r) => r.collection_id === collectionId)
        .sort((a, b) => a.position - b.position || a.added_at - b.added_at);
      return items.map((r) => ({
        fingerprint: r.fingerprint,
        position: r.position,
        added_at: r.added_at,
      }));
    });
  },

  async addToCollection(collectionId, fingerprints) {
    await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
      const all = await requestToPromise(stores[ITEMS_STORE].getAll());
      const existing = (all as CollectionItemRecord[]).filter(
        (r) => r.collection_id === collectionId,
      );
      let maxPos = existing.reduce((m, r) => Math.max(m, r.position), -1);
      const now = Date.now();
      const existingFingerprints = new Set(existing.map((r) => r.fingerprint));
      for (const fingerprint of fingerprints) {
        if (existingFingerprints.has(fingerprint)) continue;
        maxPos += 1;
        const record: CollectionItemRecord = {
          collection_id: collectionId,
          fingerprint: fingerprint,
          position: maxPos,
          added_at: now,
        };
        await requestToPromise(
          stores[ITEMS_STORE].put(record, itemKey(collectionId, fingerprint)),
        );
      }
    });
  },

  async removeFromCollection(collectionId, fingerprints) {
    await withStores(openDb, [ITEMS_STORE], "readwrite", async (stores) => {
      await Promise.all(
        fingerprints.map((fingerprint) =>
          requestToPromise(
            stores[ITEMS_STORE].delete(itemKey(collectionId, fingerprint)),
          ),
        ),
      );
    });
  },
};
