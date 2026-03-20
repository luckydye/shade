import type { ArtboardClip, Artboard, RenderedTile } from "./types";
import type { WorldTransform } from "./transform";

type TileSurface = HTMLCanvasElement | OffscreenCanvas;

const tileSurfaceCache = new WeakMap<ImageData, TileSurface>();

function createTileSurface(image: ImageData): TileSurface {
  const cached = tileSurfaceCache.get(image);
  if (cached) return cached;
  const surface =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(image.width, image.height)
      : document.createElement("canvas");
  if (surface instanceof HTMLCanvasElement) {
    surface.width = image.width;
    surface.height = image.height;
  }
  const surfaceCtx = surface.getContext("2d");
  if (!surfaceCtx) throw new Error("tile surface 2d context required");
  surfaceCtx.putImageData(image, 0, 0);
  tileSurfaceCache.set(image, surface);
  return surface;
}

// Draw one tile onto a canvas context at its correct screen position for the
// given artboard transform.
function drawTile(
  ctx: CanvasRenderingContext2D,
  tile: RenderedTile,
  artboard: Artboard,
  t: WorldTransform,
) {
  const sx = (artboard.worldX + tile.x) * t.scale + t.dx;
  const sy = (artboard.worldY + tile.y) * t.scale + t.dy;
  const sw = tile.width * t.scale;
  const sh = tile.height * t.scale;
  if (sw <= 0 || sh <= 0) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(createTileSurface(tile.image), sx, sy, sw, sh);
}

// Composite one artboard: draw the low-res backdrop first, then the high-res
// preview tile on top. Either tile may be null if not yet available.
//
// When a clip is provided it defines the committed crop region (artboard-local coords,
// rotation in radians). For rotated crops the clip is a "projection": the canvas is
// counter-rotated around the clip center so the rotated region appears axis-aligned
// on screen (like a standard de-rotated crop result). The clip boundary is set first
// (before the rotation) so it is always axis-aligned in screen space.
export function compositeArtboard(
  ctx: CanvasRenderingContext2D,
  artboard: Artboard,
  backdrop: RenderedTile | null,
  preview: RenderedTile | null,
  t: WorldTransform,
  clip?: ArtboardClip,
): void {
  ctx.save();
  if (clip) {
    const sx = (artboard.worldX + clip.x) * t.scale + t.dx;
    const sy = (artboard.worldY + clip.y) * t.scale + t.dy;
    const sw = clip.width * t.scale;
    const sh = clip.height * t.scale;
    if (sw <= 0 || sh <= 0) {
      ctx.restore();
      return;
    }
    // Clip is set BEFORE the canvas rotation so it is axis-aligned in screen space.
    // ctx.clip() transforms the path via the current CTM (only DPR scale here),
    // locking the clip in screen coordinates regardless of subsequent CTM changes.
    const clipPath = new Path2D();
    clipPath.rect(sx, sy, sw, sh);
    ctx.clip(clipPath);

    if (clip.rotation !== 0) {
      // Counter-rotate the canvas around the clip center so the rotated crop region
      // is projected onto the axis-aligned screen rectangle defined by the clip above.
      // Tiles are drawn in their original artboard orientation; the canvas transform
      // makes the rotated region appear straight to the viewer.
      const scx = sx + sw / 2;
      const scy = sy + sh / 2;
      ctx.translate(scx, scy);
      ctx.rotate(-clip.rotation);
      ctx.translate(-scx, -scy);
    }
  }
  if (backdrop) drawTile(ctx, backdrop, artboard, t);
  if (preview) drawTile(ctx, preview, artboard, t);
  ctx.restore();
}
