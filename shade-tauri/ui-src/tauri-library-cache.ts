import type {
  LibraryCachePlatform,
  LibraryImage,
  LibraryImageListing,
  SharedPicture,
} from "shade-ui/src/bridge/index";
import {
  listLibraryImages,
  listPeerPictures,
} from "shade-ui/src/bridge/index";
import { getThumbnailBackend } from "shade-ui/src/bridge/thumbnail-backend";
import {
  normalizeModifiedAt,
  normalizeRating,
  normalizeTags,
} from "shade-ui/src/cache-utils";

const tauriLocalLibraryListings = new Map<string, LibraryImageListing>();
const tauriCameraLibraryItems = new Map<string, LibraryImage[]>();
const tauriPeerLibraryItems = new Map<string, SharedPicture[]>();

function abortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("thumbnail load aborted", "AbortError");
  }
  return new Error("thumbnail load aborted");
}

function normalizeSnapshotVersion(version: unknown) {
  return typeof version === "string" && version.length > 0 ? version : null;
}

function normalizeLibraryImage(image: LibraryImage): LibraryImage {
  return {
    path: image.path,
    name: image.name,
    modified_at: normalizeModifiedAt(
      (image as LibraryImage & { modified_at?: unknown }).modified_at,
    ),
    file_hash:
      typeof image.file_hash === "string" && image.file_hash.length > 0
        ? image.file_hash
        : null,
    metadata: {
      has_snapshots: image.metadata?.has_snapshots ?? false,
      latest_snapshot_id: normalizeSnapshotVersion(
        image.metadata?.latest_snapshot_id,
      ),
      rating: normalizeRating(image.metadata?.rating),
      tags: normalizeTags(image.metadata?.tags),
    },
  };
}

function normalizeLibraryImageListing(listing: LibraryImageListing): LibraryImageListing {
  return {
    items: listing.items.map(normalizeLibraryImage),
    is_complete: listing.is_complete,
  };
}

function normalizeSharedPicture(picture: SharedPicture): SharedPicture {
  return {
    id: picture.id,
    name: picture.name,
    modified_at: normalizeModifiedAt(
      (picture as SharedPicture & { modified_at?: unknown }).modified_at,
    ),
    has_snapshots: picture.has_snapshots ?? false,
    latest_snapshot_id:
      typeof picture.latest_snapshot_id === "string" &&
      picture.latest_snapshot_id.length > 0
        ? picture.latest_snapshot_id
        : null,
  };
}

async function thumbnailObjectUrl(
  loadBytes: Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    throw abortError();
  }
  const bytes = await loadBytes;
  if (signal.aborted) {
    throw abortError();
  }
  const blobBytes = Uint8Array.from(bytes);
  return URL.createObjectURL(
    new Blob([blobBytes.buffer], { type: "image/jpeg" }),
  );
}

export const tauriLibraryCache: LibraryCachePlatform = {
  async getCachedLocalLibraryItems(libraryId) {
    return tauriLocalLibraryListings.get(libraryId)?.items ?? [];
  },
  async loadLocalLibraryItemsCachedOrRemote(libraryId) {
    const listing = normalizeLibraryImageListing(await listLibraryImages(libraryId));
    tauriLocalLibraryListings.set(libraryId, listing);
    return listing;
  },
  async getCachedCameraLibraryItems(host) {
    return tauriCameraLibraryItems.get(host) ?? [];
  },
  async loadCameraLibraryItemsCachedOrRemote(host) {
    const items = normalizeLibraryImageListing(
      await listLibraryImages(`ccapi:${host}`),
    ).items;
    tauriCameraLibraryItems.set(host, items);
    return items;
  },
  async getCachedPeerLibraryItems(peerId) {
    return tauriPeerLibraryItems.get(peerId) ?? [];
  },
  async loadPeerLibraryItemsCachedOrRemote(peerId) {
    const pictures = (await listPeerPictures(peerId)).map(normalizeSharedPicture);
    tauriPeerLibraryItems.set(peerId, pictures);
    return pictures;
  },
  async removePeerLibrary(peerId) {
    tauriPeerLibraryItems.delete(peerId);
  },
  resolveLocalThumbnailSrc(path, latestSnapshotId, signal) {
    const thumbnailPath = latestSnapshotId ? `${path}#snapshot:${latestSnapshotId}` : path;
    return thumbnailObjectUrl(
      getThumbnailBackend().getThumbnailBytes(thumbnailPath),
      signal,
    );
  },
  resolveCameraThumbnailSrc(path, latestSnapshotId, signal) {
    const thumbnailPath = latestSnapshotId ? `${path}#snapshot:${latestSnapshotId}` : path;
    return thumbnailObjectUrl(
      getThumbnailBackend().getThumbnailBytes(thumbnailPath),
      signal,
    );
  },
  resolvePeerThumbnailSrc(peerId, pictureId, signal) {
    return thumbnailObjectUrl(
      getThumbnailBackend().getPeerThumbnailBytes(peerId, pictureId),
      signal,
    );
  },
  resetLocalThumbnailFailure() {},
  resetCameraThumbnailFailure() {},
};
