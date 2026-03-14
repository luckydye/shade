import { getThumbnail } from "./bridge/index";

function abortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("thumbnail load aborted", "AbortError");
  }
  return new Error("thumbnail load aborted");
}

export async function resolveMediaSrc(path: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void getThumbnail(path)
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
