import { requestToPromise, withStores } from "./indexed-db";

const DB_NAME = "shade-browser-ratings";
const DB_VERSION = 1;
const RATINGS_STORE = "ratings";

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB is required for browser ratings");
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RATINGS_STORE)) {
        db.createObjectStore(RATINGS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function listBrowserRatings(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) {
    return {};
  }
  return withStores(openDb, [RATINGS_STORE], "readonly", async (stores) => {
    const results = await Promise.all(
      ids.map((id) => requestToPromise<unknown>(stores[RATINGS_STORE].get(id))),
    );
    const ratings: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) {
      const value = results[i];
      if (typeof value === "number") {
        ratings[ids[i]!] = value;
      }
    }
    return ratings;
  });
}

export async function setBrowserRating(id: string, rating: number | null): Promise<void> {
  await withStores(openDb, [RATINGS_STORE], "readwrite", async (stores) => {
    if (rating === null) {
      await requestToPromise(stores[RATINGS_STORE].delete(id));
    } else {
      await requestToPromise(stores[RATINGS_STORE].put(rating, id));
    }
  });
}

export const browserRatingsPlatform = {
  listRatings: listBrowserRatings,
  setRating: setBrowserRating,
};
