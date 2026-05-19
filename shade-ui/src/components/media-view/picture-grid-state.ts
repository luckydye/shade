import { createSignal } from "solid-js";
import type { MediaGridRow } from "./media-utils";

const PICTURE_GRID_ZOOM_LEVELS = [80, 100, 120, 160, 200, 260, 320] as const;
const [pictureGridColumns, setPictureGridColumns] = createSignal(1);
const [pictureGridRows, setPictureGridRows] = createSignal<MediaGridRow[]>([]);
const [pictureGridZoomIndex, setPictureGridZoomIndex] = createSignal(3);

const zoomPictureGridIn = () =>
  setPictureGridZoomIndex((index) =>
    Math.min(PICTURE_GRID_ZOOM_LEVELS.length - 1, index + 1),
  );

const zoomPictureGridOut = () =>
  setPictureGridZoomIndex((index) => Math.max(0, index - 1));

export {
  PICTURE_GRID_ZOOM_LEVELS,
  pictureGridColumns,
  pictureGridRows,
  pictureGridZoomIndex,
  setPictureGridColumns,
  setPictureGridRows,
  setPictureGridZoomIndex,
  zoomPictureGridIn,
  zoomPictureGridOut,
};
