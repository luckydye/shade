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

export function normalizeModifiedAt(modifiedAt: unknown) {
  return typeof modifiedAt === "number" && Number.isFinite(modifiedAt)
    ? modifiedAt
    : null;
}

export function normalizeRating(rating: unknown) {
  return typeof rating === "number" &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
    ? rating
    : null;
}

export function normalizeTags(tags: unknown) {
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
    : [];
}

export function tw(...classes: string[]): string {
  return classes.filter(Boolean).join(" ");
}