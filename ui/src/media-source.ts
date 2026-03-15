import { getThumbnail } from "./bridge/index";

const MEDIA_SRC_CACHE_LIMIT = 256;
const mediaSrcCache = new Map<string, string>();
const inFlightMediaSrc = new Map<string, Promise<string>>();

function abortError() {
	if (typeof DOMException !== "undefined") {
		return new DOMException("thumbnail load aborted", "AbortError");
	}
	return new Error("thumbnail load aborted");
}

export async function resolveMediaSrc(
	path: string,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) {
		throw abortError();
	}
	const cached = mediaSrcCache.get(path);
	if (cached) {
		mediaSrcCache.delete(path);
		mediaSrcCache.set(path, cached);
		return cached;
	}
	const inFlight = inFlightMediaSrc.get(path);
	if (inFlight) {
		return waitForMediaSrc(inFlight, signal);
	}
	const pending = getThumbnail(path)
		.then((src) => {
			inFlightMediaSrc.delete(path);
			mediaSrcCache.set(path, src);
			while (mediaSrcCache.size > MEDIA_SRC_CACHE_LIMIT) {
				const oldestKey = mediaSrcCache.keys().next().value;
				if (!oldestKey) {
					break;
				}
				const oldestSrc = mediaSrcCache.get(oldestKey);
				mediaSrcCache.delete(oldestKey);
				if (oldestSrc) {
					URL.revokeObjectURL(oldestSrc);
				}
			}
			return src;
		})
		.catch((error) => {
			inFlightMediaSrc.delete(path);
			throw error;
		});
	inFlightMediaSrc.set(path, pending);
	return waitForMediaSrc(pending, signal);
}

function waitForMediaSrc(
	pending: Promise<string>,
	signal: AbortSignal,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void pending
			.then((src) => {
				signal.removeEventListener("abort", onAbort);
				if (!signal.aborted) {
					resolve(src);
				}
			})
			.catch((error) => {
				signal.removeEventListener("abort", onAbort);
				if (!signal.aborted) {
					reject(error);
				}
			});
	});
}

export function releaseMediaSrc(url: string) {
	for (const cachedUrl of mediaSrcCache.values()) {
		if (cachedUrl === url) {
			return;
		}
	}
	URL.revokeObjectURL(url);
}
