import { getThumbnailBytes, listLibraryImages, type LibraryImage } from "./bridge/index";

const DB_NAME = "shade-camera-cache";
const DB_VERSION = 2;
const ITEMS_STORE = "items";
const THUMBNAILS_STORE = "thumbnails";
const FAILURE_COOLDOWN_MS = 5_000;

type CachedFailures = Map<string, { error: unknown; retryAt: number }>;

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

async function loadCameraLibraryItems(host: string) {
	return withStores([ITEMS_STORE], "readonly", async (stores) => {
		const result = await requestToPromise(stores[ITEMS_STORE].get(host));
		return Array.isArray(result)
			? result.map((item) => normalizeLibraryImage(item as LibraryImage))
			: [];
	});
}

async function saveCameraLibraryItems(host: string, items: LibraryImage[]) {
	await withStores([ITEMS_STORE], "readwrite", async (stores) => {
		await requestToPromise(
			stores[ITEMS_STORE].put(items.map(normalizeLibraryImage), host),
		);
	});
}

function thumbnailKey(path: string) {
	return path;
}

async function getCachedThumbnail(path: string): Promise<Blob | null> {
	return withStores([THUMBNAILS_STORE], "readonly", async (stores) => {
		const result = await requestToPromise(stores[THUMBNAILS_STORE].get(thumbnailKey(path)));
		return result instanceof Blob ? result : null;
	});
}

async function putCachedThumbnail(path: string, blob: Blob): Promise<void> {
	await withStores([THUMBNAILS_STORE], "readwrite", async (stores) => {
		await requestToPromise(stores[THUMBNAILS_STORE].put(blob, thumbnailKey(path)));
	});
}

async function warmCameraLibraryThumbnails(items: LibraryImage[]) {
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const item = items[nextIndex];
			nextIndex += 1;
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

	await worker();
}

export async function getCachedCameraLibraryItems(
	host: string,
): Promise<LibraryImage[]> {
	return loadCameraLibraryItems(host);
}

export async function loadCameraLibraryItemsCachedOrRemote(
	host: string,
): Promise<LibraryImage[]> {
	try {
		const listing = await listLibraryImages(`ccapi:${host}`);
		await saveCameraLibraryItems(host, listing.items);
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

export function resetCameraThumbnailFailure(path: string) {
	failedThumbnailLoads.delete(path);
}
