import type { ArtboardClip, Artboard, RenderedTile } from "./types";
import type { WorldTransform } from "./transform";

// Draw one tile onto a canvas context at its correct screen position for the
// given artboard transform. The scratch canvas is reused across calls.
function drawTile(
  ctx: CanvasRenderingContext2D,
  tile: RenderedTile,
  artboard: Artboard,
  t: WorldTransform,
  scratch: HTMLCanvasElement,
) {
  const sx = (artboard.worldX + tile.x) * t.scale + t.dx;
  const sy = (artboard.worldY + tile.y) * t.scale + t.dy;
  const sw = tile.width * t.scale;
  const sh = tile.height * t.scale;
  if (sw <= 0 || sh <= 0) return;
  if (scratch.width !== tile.image.width || scratch.height !== tile.image.height) {
    scratch.width = tile.image.width;
    scratch.height = tile.image.height;
  }
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new Error("scratch canvas 2d context required");
  scratchCtx.putImageData(tile.image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(scratch, sx, sy, sw, sh);
}

// Composite one artboard: draw the low-res backdrop first, then the high-res
// preview tile on top. Either tile may be null if not yet available.
// The backdrop fills the artboard area providing visible content while panning;
// the preview tile provides full-resolution detail for the currently visible region.
// An optional clip rect (artboard-local, rotation in radians) constrains drawing to the
// committed crop region so the backdrop doesn't bleed outside the cropped bounds.
export function compositeArtboard(
  ctx: CanvasRenderingContext2D,
  artboard: Artboard,
  backdrop: RenderedTile | null,
  preview: RenderedTile | null,
  t: WorldTransform,
  backdropScratch: HTMLCanvasElement,
  previewScratch: HTMLCanvasElement,
  clip?: ArtboardClip,
): void {
  ctx.save();
  if (clip) {
    const sx = (artboard.worldX + clip.x) * t.scale + t.dx;
    const sy = (artboard.worldY + clip.y) * t.scale + t.dy;
    const sw = clip.width * t.scale;
    const sh = clip.height * t.scale;
    const clipPath = new Path2D();
    if (clip.rotation === 0) {
      clipPath.rect(sx, sy, sw, sh);
    } else {
      // Rotated clip rect: build path around the center, then apply rotation via DOMMatrix.
      // Path2D.addPath applies the transform before the canvas CTM, so coordinates here
      // are in the same CSS-pixel space as the drawImage calls in drawTile.
      const inner = new Path2D();
      inner.rect(-sw / 2, -sh / 2, sw, sh);
      clipPath.addPath(
        inner,
        new DOMMatrix()
          .translateSelf(sx + sw / 2, sy + sh / 2)
          .rotateSelf(clip.rotation * (180 / Math.PI)),
      );
    }
    ctx.clip(clipPath);
  }
  if (backdrop) drawTile(ctx, backdrop, artboard, t, backdropScratch);
  if (preview) drawTile(ctx, preview, artboard, t, previewScratch);
  ctx.restore();
}
