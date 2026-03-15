import {
	getPeerThumbnailBytes,
	listPeerPictures,
	type SharedPicture,
} from "./bridge/index";

const LIBRARIES_KEY = "shade.peerLibraries.v1";
const ITEMS_KEY = "shade.peerLibraryItems.v1";
const DB_NAME = "shade-peer-cache";
const STORE_NAME = "thumbnails";

export type PeerLibrary = {
	id: string;
	kind: "peer";
	name: string;
	path: null;
	removable: true;
	peerId: string;
};

export type PeerLibraryItem = {
	kind: "peer";
	id: string;
	name: string;
	peerId: string;
	modified_at: number | null;
};

function normalizeModifiedAt(modifiedAt: unknown) {
	return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
		? modifiedAt
		: null;
}

function normalizeSharedPicture(picture: SharedPicture): SharedPicture {
	return {
		id: picture.id,
		name: picture.name,
		modified_at: normalizeModifiedAt(
			(picture as SharedPicture & { modified_at?: unknown }).modified_at,
		),
	};
}

function peerLibraryId(peerId: string) {
	return `peer:${peerId}`;
}

function peerLibraryName(peerId: string) {
	return `Peer ${peerId.slice(0, 8)}`;
}

function thumbnailKey(peerId: string, pictureId: string) {
	return `${peerId}:${pictureId}`;
}

function readJson<T>(key: string, fallback: T): T {
	const raw = localStorage.getItem(key);
	if (!raw) {
		return fallback;
	}
	return JSON.parse(raw) as T;
}

function writeJson(key: string, value: unknown) {
	localStorage.setItem(key, JSON.stringify(value));
}

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

function openDb(): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined") {
		throw new Error("indexedDB is required for peer thumbnail caching");
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onerror = () => reject(request.error);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
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
	const tx = db.transaction(STORE_NAME, mode);
	const store = tx.objectStore(STORE_NAME);
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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function loadPeerLibraryIds() {
	return readJson<string[]>(LIBRARIES_KEY, []);
}

function savePeerLibraryIds(peerIds: string[]) {
	writeJson(LIBRARIES_KEY, peerIds);
}

function loadPeerLibraryItemsMap() {
	const raw = readJson<Record<string, SharedPicture[]>>(ITEMS_KEY, {});
	return Object.fromEntries(
		Object.entries(raw).map(([peerId, pictures]) => [
			peerId,
			pictures.map(normalizeSharedPicture),
		]),
	);
}

function savePeerLibraryItemsMap(items: Record<string, SharedPicture[]>) {
	writeJson(ITEMS_KEY, items);
}

async function getCachedThumbnail(
	peerId: string,
	pictureId: string,
): Promise<Blob | null> {
	return withStore("readonly", async (store) => {
		const result = await requestToPromise(
			store.get(thumbnailKey(peerId, pictureId)),
		);
		return result instanceof Blob ? result : null;
	});
}

async function putCachedThumbnail(
	peerId: string,
	pictureId: string,
	blob: Blob,
): Promise<void> {
	await withStore("readwrite", async (store) => {
		await requestToPromise(store.put(blob, thumbnailKey(peerId, pictureId)));
	});
}

async function deleteCachedPeerThumbnails(peerId: string): Promise<void> {
	await withStore("readwrite", async (store) => {
		const keys = await requestToPromise(store.getAllKeys());
		await Promise.all(
			keys
				.filter(
					(key) => typeof key === "string" && key.startsWith(`${peerId}:`),
				)
				.map((key) => requestToPromise(store.delete(key))),
		);
	});
}

function toPeerLibrary(peerId: string): PeerLibrary {
	return {
		id: peerLibraryId(peerId),
		kind: "peer",
		name: peerLibraryName(peerId),
		path: null,
		removable: true,
		peerId,
	};
}

function toPeerLibraryItems(
	peerId: string,
	pictures: SharedPicture[],
): PeerLibraryItem[] {
	return pictures.map((picture) => ({
		kind: "peer",
		id: picture.id,
		name: picture.name,
		peerId,
		modified_at: normalizeModifiedAt(picture.modified_at),
	}));
}

function persistPeerLibraryItems(peerId: string, pictures: SharedPicture[]) {
	const allItems = loadPeerLibraryItemsMap();
	allItems[peerId] = pictures.map(normalizeSharedPicture);
	savePeerLibraryItemsMap(allItems);
}

async function warmPeerLibraryThumbnails(
	peerId: string,
	pictures: SharedPicture[],
) {
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
				const bytes = await getPeerThumbnailBytes(peerId, picture.id);
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

export function listPeerLibraries(): PeerLibrary[] {
	return loadPeerLibraryIds().map(toPeerLibrary);
}

export function getCachedPeerLibraryItems(peerId: string): PeerLibraryItem[] {
	return toPeerLibraryItems(peerId, loadPeerLibraryItemsMap()[peerId] ?? []);
}

export async function addPeerLibrary(peerId: string): Promise<PeerLibrary> {
	const peerIds = loadPeerLibraryIds();
	if (!peerIds.includes(peerId)) {
		savePeerLibraryIds([...peerIds, peerId]);
	}
	return toPeerLibrary(peerId);
}

export async function removePeerLibrary(peerId: string): Promise<void> {
	savePeerLibraryIds(loadPeerLibraryIds().filter((id) => id !== peerId));
	const allItems = loadPeerLibraryItemsMap();
	delete allItems[peerId];
	savePeerLibraryItemsMap(allItems);
	await deleteCachedPeerThumbnails(peerId);
}

export async function loadPeerLibraryItems(
	peerId: string,
): Promise<PeerLibraryItem[]> {
	try {
		const pictures = await listPeerPictures(peerId);
		persistPeerLibraryItems(peerId, pictures);
		void warmPeerLibraryThumbnails(peerId, pictures);
		return toPeerLibraryItems(peerId, pictures);
	} catch (error) {
		const cachedItems = loadPeerLibraryItemsMap()[peerId] ?? [];
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
	const bytes = await getPeerThumbnailBytes(peerId, pictureId);
	if (signal.aborted) {
		throw abortError();
	}
	const blob = new Blob([toBlobBuffer(bytes)], { type: "image/jpeg" });
	await putCachedThumbnail(peerId, pictureId, blob);
	return URL.createObjectURL(blob);
}
