import ARWFile from "./ARW";
import CR2File from "./CR2";
import CR3File from "./CR3";
import DNGFile from "./DNG";
import JPEGFile from "./JPEG";
import NEFFile from "./NEF";
import PNGFile from "./PNG";
import TIFFFile from "./TIFF";

export async function parseRawImageFile(filename: string, blob: Blob) {
  const parts = filename.split(".");
  const ending = parts[parts.length - 1];

  let FileType;

  switch (ending.toLocaleUpperCase()) {
    case "CR2":
      FileType = CR2File;
      break;
    case "CR3":
      FileType = CR3File;
      break;
    case "ARW":
      FileType = ARWFile;
      break;
    case "DNG":
      FileType = DNGFile;
      break;
    case "NEF":
      FileType = NEFFile;
      break;
    case "TIF":
    case "TIFF":
      FileType = TIFFFile;
      break;
  }

  if (!FileType) {
    throw new Error("File type not supported.");
  }

  const arrayBuffer = await blob.arrayBuffer();
  return new FileType(arrayBuffer);
}
