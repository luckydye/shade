import TIFFFile from "./TIFF";
import {
  Compression,
  PhotometricInterp,
  PlanarConfig,
  CFAColor,
} from "./TagTypes";

export default class DNGFile extends TIFFFile {
  get type() { return "DNG"; }

  static handleLosslessJPEGImage(tags, image) {
    // lossless Huffman JPEG

    const planarConfig = tags["PlanarConfiguration"][0];
    const photometricInterp = tags["PhotometricInterpretation"][0];
    void planarConfig;

    switch (photometricInterp) {
      case PhotometricInterp.BLACK_IS_ZERO:
      case PhotometricInterp.RGB:
      case PhotometricInterp.YCBCR:
        break;
      case PhotometricInterp.CFA:
        const imageData = [];

        for (let i = 0; i < image.tiles.length; i++) {
          for (let y = 0; y < image.tiles[i].length; y++) {
            imageData.push(image.tiles[i][y]);
          }
        }

        image.type = "raw";
        image.imageData = imageData;

        // this.decodeCFALayout(tags, image);
        break;
      case PhotometricInterp.LINEAR_RAW:
      case PhotometricInterp.DEPTH:
        break;
    }
  }

  static decodeCFALayout(tags, image) {
    const bitsPerSample = tags["BitsPerSample"][0];

    const minIntensity = 0;
    const maxIntensity = 2 ** bitsPerSample - 1;

    const cfaRepPttrn = tags["CFARepeatPatternDim"];
    const cfaPattern = tags["CFAPattern"];
    const cfaLayout = tags["CFALayout"];

    const pattern0 = cfaPattern.slice(0, cfaRepPttrn[0]);
    const pattern1 = cfaPattern.slice(
      cfaRepPttrn[0],
      cfaRepPttrn[0] + cfaRepPttrn[1]
    );
    void pattern0;
    void pattern1;

    const pixelArray = [];

    for (let x = 0; x < image.width; x++) {
      for (let y = 0; y < image.height; y++) {
        let r = 0,
          g = 0,
          b = 0;

        const rowLength = image.width * 2;

        const rIndex = x * 2 + rowLength * y;
        const gIndex = x * 2 + 1 + rowLength * y;
        const bIndex = x * 2 + rowLength + rowLength * y;

        const pixel = [
          image.rawData[rIndex],
          image.rawData[gIndex],
          image.rawData[bIndex],
        ];

        pixelArray.push(...pixel);
      }
    }

    image.imageData = pixelArray;
    image.type = "raw";
  }

  async getThumbnail() {
    return new Blob([this._images[2].imageData], { type: "image/png" });
  }
}
