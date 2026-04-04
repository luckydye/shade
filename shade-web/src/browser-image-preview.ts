import { parseRawImageFile } from "./files/index";

const PARSED_PREVIEW_EXTENSIONS = new Set([
  ".arw",
  ".cr2",
  ".cr3",
  ".dng",
  ".nef",
  ".tif",
  ".tiff",
]);
const THUMBNAIL_SIZE = 512;

type RawPreviewFile = {
  getThumbnail(): Promise<Blob> | Blob;
};

type ParsedImageData = {
  format: string | null;
  data: Uint8ClampedArray | Uint8Array | null;
  width: number | null;
  height: number | null;
};

type ParsedDisplayFile = RawPreviewFile & {
  getImageData?: () => Promise<ParsedImageData>;
};

function fileExtension(fileName: string): string {
  const queryIndex = fileName.indexOf("?");
  const cleanName = queryIndex >= 0 ? fileName.slice(0, queryIndex) : fileName;
  const dotIndex = cleanName.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }
  return cleanName.slice(dotIndex).toLowerCase();
}

export function fileNameFromPath(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex < 0) {
    return trimmed;
  }
  return trimmed.slice(slashIndex + 1);
}

function replaceFileExtension(fileName: string, nextExtension: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0) {
    return `${fileName}${nextExtension}`;
  }
  return `${fileName.slice(0, dotIndex)}${nextExtension}`;
}

function displayFileName(fileName: string, blob: Blob): string {
  switch (blob.type) {
    case "image/jpeg":
    case "image/jpg":
      return replaceFileExtension(fileName, ".jpg");
    case "image/png":
      return replaceFileExtension(fileName, ".png");
    default:
      return fileName;
  }
}

function rgbaPixelsFromParsedImageData(imageData: ParsedImageData): Uint8ClampedArray {
  const width = imageData.width ?? 0;
  const height = imageData.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("parsed image dimensions are invalid");
  }
  if (!(imageData.data instanceof Uint8Array || imageData.data instanceof Uint8ClampedArray)) {
    throw new Error("parsed image pixels are unavailable");
  }
  if (imageData.format === "RGBA") {
    return imageData.data instanceof Uint8ClampedArray
      ? imageData.data
      : new Uint8ClampedArray(imageData.data);
  }
  if (imageData.format === "RGB") {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let src = 0, dst = 0; src < imageData.data.length; src += 3, dst += 4) {
      rgba[dst] = imageData.data[src] ?? 0;
      rgba[dst + 1] = imageData.data[src + 1] ?? 0;
      rgba[dst + 2] = imageData.data[src + 2] ?? 0;
      rgba[dst + 3] = 255;
    }
    return rgba;
  }
  throw new Error(`unsupported parsed image format: ${String(imageData.format)}`);
}

async function encodeParsedImageDataAsPng(
  fileName: string,
  parsedFile: ParsedDisplayFile,
): Promise<Blob> {
  if (typeof parsedFile.getImageData !== "function") {
    throw new Error(`parsed preview image data is unavailable for ${fileName}`);
  }
  const imageData = await parsedFile.getImageData();
  const width = imageData.width ?? 0;
  const height = imageData.height ?? 0;
  const rgba = rgbaPixelsFromParsedImageData(imageData);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2d canvas context is unavailable");
  }
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  const encodedBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!encodedBlob) {
    throw new Error(`failed to encode parsed image for ${fileName}`);
  }
  return encodedBlob;
}

async function canRenderNatively(blob: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}

async function resolveRenderableBlob(fileName: string, blob: Blob): Promise<Blob> {
  const extension = fileExtension(fileName);
  if (!PARSED_PREVIEW_EXTENSIONS.has(extension)) {
    return blob;
  }
  if ((extension === ".tif" || extension === ".tiff") && (await canRenderNatively(blob))) {
    return blob;
  }
  const parsedFile = (await parseRawImageFile(fileName, blob)) as ParsedDisplayFile;
  if (extension === ".tif" || extension === ".tiff") {
    return encodeParsedImageDataAsPng(fileName, parsedFile);
  }
  const thumbnail = await parsedFile.getThumbnail();
  if (!(thumbnail instanceof Blob) || thumbnail.size === 0) {
    throw new Error(`failed to extract raw preview for ${fileName}`);
  }
  return thumbnail;
}

export async function loadBrowserDisplayBytes(
  fileName: string,
  blob: Blob,
): Promise<{ bytes: ArrayBuffer; fileName: string }> {
  const renderableBlob = await resolveRenderableBlob(fileName, blob);
  return {
    bytes: await renderableBlob.arrayBuffer(),
    fileName: displayFileName(fileName, renderableBlob),
  };
}

export async function loadBrowserThumbnailBytes(
  fileName: string,
  blob: Blob,
): Promise<Uint8Array> {
  const renderableBlob = await resolveRenderableBlob(fileName, blob);
  const bitmap = await createImageBitmap(renderableBlob);
  const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2d canvas context is unavailable");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const encodedBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.82);
  });
  if (!encodedBlob) {
    throw new Error(`failed to create thumbnail for ${fileName}`);
  }
  return new Uint8Array(await encodedBlob.arrayBuffer());
}
