import * as bridge from "../bridge/index";

export function resolveLocalThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return bridge.resolveLocalThumbnailSrc(path, latestSnapshotId, signal);
}

export function resolveCameraThumbnailSrc(
  path: string,
  latestSnapshotId: string | null,
  signal: AbortSignal,
): Promise<string> {
  return bridge.resolveCameraThumbnailSrc(path, latestSnapshotId, signal);
}

export function resolvePeerThumbnailSrc(
  peerId: string,
  pictureId: string,
  signal: AbortSignal,
): Promise<string> {
  return bridge.resolvePeerThumbnailSrc(peerId, pictureId, signal);
}

export function resetLocalThumbnailFailure(path: string): void {
  bridge.resetLocalThumbnailFailure(path);
}

export function resetCameraThumbnailFailure(path: string): void {
  bridge.resetCameraThumbnailFailure(path);
}
