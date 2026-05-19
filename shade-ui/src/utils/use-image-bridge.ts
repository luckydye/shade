import * as bridge from "../bridge/index";
import {
  getArtboardTiles,
  nextGeneration,
  type RenderedTile as PushedRenderedTile,
  subscribeTiles,
} from "../bridge/preview";
import { getTransport } from "../bridge/transport";
import type {
  ArtboardViewport,
  PreviewFrame,
  PreviewQuality,
  SharedPicture,
} from "../types";
import { onImageOpenPhase } from "./use-image-open-phase";

export type {
  ArtboardViewport,
  PreviewFrame,
  PreviewQuality,
  PushedRenderedTile,
  SharedPicture,
};

function sendPreviewViewports(args: {
  generation: number;
  quality: PreviewQuality;
  viewports: ArtboardViewport[];
  use_float16: boolean;
}) {
  getTransport().sendPreviewViewports(args);
}

export function useImageBridge() {
  return {
    renderPreview: bridge.renderPreview,
    openImage: bridge.openImage,
    prepareImageOpen: bridge.prepareImageOpen,
    openImageFile: bridge.openImageFile,
    openPeerImage: bridge.openPeerImage,
    restoreCurrentBrowserSnapshot: bridge.restoreCurrentBrowserSnapshot,
    exportImage: bridge.exportImage,
    pickExportTarget: bridge.pickExportTarget,
    setMediaRating: bridge.setMediaRating,
    onImageOpenPhase,
    getArtboardTiles,
    nextGeneration,
    subscribeTiles,
    sendPreviewViewports,
  };
}
