/**
 * Runtime detection. Tauri exposes `__TAURI_INTERNALS__` on `window`; the web
 * build does not. Synchronous, no-throw — safe to call before any host hooks
 * are installed (returns `false` if window is unavailable, e.g. inside a worker).
 */
export function isTauriRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    "__TAURI_INTERNALS__" in (globalThis as { window: object }).window
  );
}