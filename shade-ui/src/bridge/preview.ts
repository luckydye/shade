/**
 * Preview channel — pushes pixel frames from Rust to JS.
 *
 * Frames arrive as a binary blob (`ArrayBuffer`) with a small JSON header
 * followed by raw pixel bytes. The header carries everything except the
 * pixels themselves so the body never needs to be JSON-decoded.
 *
 * The frontend owns the `generation` counter: it increments on every viewport
 * update and frames with a stale generation are discarded.
 */

import type {
  ArtboardViewport,
  PreviewCropMessage,
  PreviewQuality,
  UpdatePreviewViewportsArgs,
} from "./types";

export type PreviewFrameKind = "rgba" | "rgba-float16";
export type PreviewColorSpace = "srgb" | "display-p3";

export interface PreviewFramePush {
  artboard_id: string;
  generation: number;
  quality: PreviewQuality;
  width: number;
  height: number;
  crop_x: number;
  crop_y: number;
  crop_width: number;
  crop_height: number;
  kind: PreviewFrameKind;
  color_space: PreviewColorSpace;
  pixels: Uint8Array;
}

export interface RenderedTile {
  image: ImageData;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ArtboardTiles {
  interactive: RenderedTile | null;
  final: RenderedTile | null;
}

const tileMap = new Map<string, ArtboardTiles>();
const tileSubscribers = new Set<(artboardId: string) => void>();

let currentGeneration = 0;

export function nextGeneration(): number {
  currentGeneration += 1;
  return currentGeneration;
}

export function getCurrentGeneration(): number {
  return currentGeneration;
}

export function getArtboardTiles(artboardId: string): ArtboardTiles | null {
  return tileMap.get(artboardId) ?? null;
}

export function subscribeTiles(cb: (artboardId: string) => void): () => void {
  tileSubscribers.add(cb);
  return () => {
    tileSubscribers.delete(cb);
  };
}

function notifyTileChanged(artboardId: string) {
  for (const cb of tileSubscribers) {
    try {
      cb(artboardId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[preview] tile subscriber threw", err);
    }
  }
}

function parseFrameHeader(buffer: ArrayBuffer): {
  header: Omit<PreviewFramePush, "pixels">;
  pixelOffset: number;
} {
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  const headerJson = new TextDecoder().decode(new Uint8Array(buffer, 4, headerLen));
  const header = JSON.parse(headerJson) as Omit<PreviewFramePush, "pixels">;
  return { header, pixelOffset: 4 + headerLen };
}

function frameToImageData(frame: PreviewFramePush): ImageData {
  if (frame.kind === "rgba-float16") {
    const Float16 = (
      globalThis as unknown as {
        Float16Array?: new (
          buf: ArrayBufferLike,
          byteOffset?: number,
          length?: number,
        ) => unknown;
      }
    ).Float16Array;
    if (!Float16) {
      throw new Error("Float16Array not available for rgba-float16 preview");
    }
    const pixels = new Float16(
      frame.pixels.buffer,
      frame.pixels.byteOffset,
      frame.pixels.byteLength / 2,
    );
    return new ImageData(pixels as never, frame.width, frame.height, {
      pixelFormat: "rgba-float16",
      colorSpace: frame.color_space,
    } as ImageDataSettings);
  }
  // Copy into a freshly-owned ArrayBuffer to satisfy ImageData's typing.
  const owned = new Uint8ClampedArray(frame.pixels.byteLength);
  owned.set(frame.pixels);
  return new ImageData(owned, frame.width, frame.height);
}

function applyFrame(frame: PreviewFramePush) {
  if (frame.generation < currentGeneration) {
    return; // stale
  }
  const image = frameToImageData(frame);
  const tile: RenderedTile = {
    image,
    x: frame.crop_x,
    y: frame.crop_y,
    width: frame.crop_width,
    height: frame.crop_height,
  };
  const existing = tileMap.get(frame.artboard_id) ?? {
    interactive: null,
    final: null,
  };
  if (frame.quality === "final") {
    existing.final = tile;
  } else {
    existing.interactive = tile;
  }
  tileMap.set(frame.artboard_id, existing);
  notifyTileChanged(frame.artboard_id);
}

/**
 * Install the platform's preview channel. The platform delivers each frame as
 * a raw `ArrayBuffer`; this function decodes the header + pixels and routes
 * the result through the stale-frame check + tile map.
 */
let previewInstalled = false;
export async function installPreviewChannel(
  register: (handler: (buffer: ArrayBuffer) => void) => Promise<void>,
): Promise<void> {
  if (previewInstalled) return;
  previewInstalled = true;
  await register((buffer) => {
    const { header, pixelOffset } = parseFrameHeader(buffer);
    const pixels = new Uint8Array(buffer, pixelOffset, buffer.byteLength - pixelOffset);
    applyFrame({ ...header, pixels });
  });
}

export type { PreviewCropMessage };
