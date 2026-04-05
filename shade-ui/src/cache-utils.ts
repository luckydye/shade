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
