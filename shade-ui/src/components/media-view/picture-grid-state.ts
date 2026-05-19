import { createSignal } from "solid-js";
import type { MediaGridRow } from "./media-utils";

const [pictureGridColumns, setPictureGridColumns] = createSignal(1);
const [pictureGridRows, setPictureGridRows] = createSignal<MediaGridRow[]>([]);

export { pictureGridColumns, pictureGridRows, setPictureGridColumns, setPictureGridRows };
