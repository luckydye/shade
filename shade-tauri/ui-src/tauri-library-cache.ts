import type { HostHooks } from "shade-ui/src/bridge/host";
import type {
  LibraryImage,
  LibraryImageListing,
  SharedPicture,
} from "shade-ui/src/bridge/index";

type LibraryCacheHooks = Pick<
  HostHooks,
  | "getCachedLocalLibraryItems"
  | "loadLocalLibraryItemsCachedOrRemote"
  | "getCachedCameraLibraryItems"
  | "loadCameraLibraryItemsCachedOrRemote"
  | "getCachedPeerLibraryItems"
  | "loadPeerLibraryItemsCachedOrRemote"
  | "removePeerLibrary"
  | "resolveLocalThumbnailSrc"
  | "resolveCameraThumbnailSrc"
  | "resolvePeerThumbnailSrc"
  | "resetLocalThumbnailFailure"
  | "resetCameraThumbnailFailure"
>;
import {
  listLibraryImages,
  listPeerPictures,
} from "shade-ui/src/bridge/index";
import {
  shadePeerThumbnailUrl,
  shadeThumbnailUrl,
} from "shade-ui/src/bridge/channel";
import {
  normalizeModifiedAt,
  normalizeRating,
  normalizeTags,
} from "shade-ui/src/cache-utils";

const tauriLocalLibraryListings = new Map<string, LibraryImageListing>();
const tauriCameraLibraryItems = new Map<string, LibraryImage[]>();
const tauriPeerLibraryItems = new Map<string, SharedPicture[]>();

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
    fingerprint:
      typeof image.fingerprint === "string" && image.fingerprint.length > 0
        ? image.fingerprint
        : null,
    metadata: {
      has_snapshots: image.metadata?.has_snapshots ?? false,
      latest_snapshot_id: normalizeSnapshotVersion(
        image.metadata?.latest_snapshot_id,
      ),
      latest_snapshot_created_at: image.metadata?.latest_snapshot_created_at ?? null,
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

export const tauriLibraryCache: LibraryCacheHooks = {
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
  async resolveLocalThumbnailSrc(path, latestSnapshotId) {
    const thumbPath = latestSnapshotId
      ? `${path}#snapshot:${latestSnapshotId}`
      : path;
    return shadeThumbnailUrl(thumbPath, latestSnapshotId);
  },
  async resolveCameraThumbnailSrc(path, latestSnapshotId) {
    const thumbPath = latestSnapshotId
      ? `${path}#snapshot:${latestSnapshotId}`
      : path;
    return shadeThumbnailUrl(thumbPath, latestSnapshotId);
  },
  async resolvePeerThumbnailSrc(peerId, pictureId) {
    return shadePeerThumbnailUrl(peerId, pictureId);
  },
  resetLocalThumbnailFailure() {},
  resetCameraThumbnailFailure() {},
};
