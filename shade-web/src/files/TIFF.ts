import { BinaryFile } from "../BinaryFile";
import RawImageData from "./RawImageData";
import {
  Compression, 
  FIELDS, 
  FIELD_TYPE,
  PhotometricInterp,
  Subfile
} from "./TagTypes";

class Canvas {
  constructor() {
    return document.createElement('canvas');
  }
}

const ImageCanvas = 'OffscreenCanvas' in globalThis ? OffscreenCanvas : Canvas;

export default class TIFFFile extends BinaryFile {
  static get FileHeader() {
    return {
      byteOrder: "char[2]",
      number: "unsigned short",
      ifdOffset: "unsigned int",
    };
  }

  static get DirectoryHeader() {
    return {
      entryCount: "unsigned short",
    };
  }

  static get Entry() {
    return {
      tag: "unsigned short",
      type: "unsigned short",
      count: "unsigned int",
      valueOffset: "unsigned int",
    };
  }

  static get MAX_IFD_COUNT() {
    return 10;
  }

  static get LITTLE_ENDIAN() {
    return "II";
  }

  static get BIG_ENDIAN() {
    return "MM";
  }

  static get FIELDS() {
    return FIELDS;
  }

  static get FIELD_TYPE() {
    return FIELD_TYPE;
  }

  static verifyFileHeader(file) {
    const byteOrder = String.fromCharCode(
      file.view.getUint8(0),
      file.view.getUint8(1),
    );
    const littleEndian =
      byteOrder === this.LITTLE_ENDIAN
        ? true
        : byteOrder === this.BIG_ENDIAN
          ? false
          : null;
    if (littleEndian === null) {
      throw new Error("File not compatible");
    }
    const header = this.unserialize(file, 0, this.FileHeader, littleEndian);
    const n = this.getValue(header, "number");
    if (n === 43) {
      throw new Error("BigTIFF is not supported");
    }
    if (n !== 42) {
      throw new Error("File not compatible");
    }
    file._littleEndian = littleEndian;

    return header;
  }

  static parseFile(file) {
    // read file header
    const header = this.verifyFileHeader(file);

    this.parseIFDs(file, this.getValue(header, "ifdOffset"));
    this.parseMetaData(file);
    this.parseImages(file);
  }

  static parseIFDs(file, offset) {
    // unserialize Image File Directory
    let nextIfdOffset = offset;
    let counter = 0;

    file._ifds = [];

    while (nextIfdOffset > 0 && counter < this.MAX_IFD_COUNT) {
      counter++;

      const ifd = this.parseIFD(file, nextIfdOffset);
      file._ifds.push(ifd.tags);

      nextIfdOffset = ifd.next;
    }
    // Sub IFDs
    if (file.getTag("SubIFDs")) {
      const subIFDs = file.getTag("SubIFDs");

      for (let offset of subIFDs) {
        const subIfd = this.parseIFD(file, offset);
        file._ifds.push(subIfd.tags);
      }
    }
  }

  static parseMetaData(file) {
    // EXIF Data
    if (file.getTag("EXIF")) {
      const pointer = file.getTag("EXIF")[0];
      const exifSub = this.parseIFD(file, pointer);
      file._exif = exifSub.tags;

      if (file._exif["Makernote"]) {
        const pointer = file._exif["Makernote"][0];
        const makernote = this.parseIFD(file, pointer);
        file._exif["Makernote"] = makernote.tags;
      }
    }

    // GPS Data
    if (file.getTag("GPS")) {
      const pointer = file.getTag("GPS")[0];
      const data = this.parseIFD(file, pointer);
      file._gps = data.tags;
    }

    file.date = file.getTag("DateTime");
  }

  static parseImages(file) {
    file._images = [];
    for (let ifd of file._ifds) {
      const image = this.parseIFDImage(file, ifd);
      image.orientation = ifd["Orientation"]?.[0] ?? file.getTag("Orientation")?.[0] ?? 1;
      file._images.push(image);
    }
  }

  static parseIFDImage(file, tags) {
    const image = {};

    if (tags["ImageWidth"]) {
      image.width = tags["ImageWidth"] ? tags["ImageWidth"][0] : 0;
      image.height = tags["ImageLength"] ? tags["ImageLength"][0] : 0;
    }

    if (tags["NewSubfileType"]) {
      const subFileType = tags["NewSubfileType"][0];
      image.thumbnail = subFileType === Subfile.THUMBNAIL;
    }

    image.bitsPerSample = tags["BitsPerSample"];

    // unpack tiles or strips data
    if (tags["StripOffsets"]) {
      // strips

      const stripByteCounts = tags["StripByteCounts"];
      const stripOffsets = tags["StripOffsets"];

      image.strips = [];

      for (let i = 0; i < stripOffsets.length; i++) {
        const offset = stripOffsets[i];
        const bytelength = stripByteCounts[i];

        const data = file.buffer.slice(offset, offset + bytelength);
        image.strips.push(data);
      }
    } else if (tags["TileOffsets"]) {
      // tiles

      const tileWidth = tags["TileWidth"][0];
      const tileHeight = tags["TileLength"][0];

      const tileOffsets = tags["TileOffsets"];
      const tileByteCounts = tags["TileByteCounts"];

      image.tiles = [];

      for (let i = 0; i < tileOffsets.length; i++) {
        const offset = tileOffsets[i];
        const bytelength = tileByteCounts[i];

        const data = file.buffer.slice(offset, offset + bytelength);
        image.tiles.push(data);
      }
    } else if (tags["ThumbnailOffset"]) {
      // thumbnail
      const offset = tags["ThumbnailOffset"];
      const bytelength = tags["ThumbnailLength"];

      const data = file.buffer.slice(offset, offset + bytelength);
      image.imageData = data;
      image.thumbnail = true;
    }

    // handle compression
    if (tags["Compression"]) {
      const compression = tags["Compression"][0];
      image.compression = compression;

      for (let key in Compression) {
        if (Compression[key] == compression) {
          const handler = this.compressionHandlers[key];
          handler(tags, image);
        }
      }
    }

    return image;
  }

  static get compressionHandlers() {
    return {
      UNCOMPRESSED: this.handleUncompressedImage.bind(this),
      TIFF_JPEG: this.handleJPEGImage.bind(this),
      JPEG: this.handleJPEGImage.bind(this),
      ZIP: this.handleZIPImage.bind(this),
      LOSSY_JPEG: this.handleLossyJPEGImage.bind(this),
    };
  }

  static handleUncompressedImage(tags, image) {
    if (!image.strips || image.strips.length === 0) {
      throw new Error("TIFF image strips are missing");
    }
    const strips = image.strips.map((strip) => new Uint8Array(strip));
    const byteLength = strips.reduce((sum, strip) => sum + strip.byteLength, 0);
    const merged = new Uint8Array(byteLength);
    let offset = 0;
    for (const strip of strips) {
      merged.set(strip, offset);
      offset += strip.byteLength;
    }
    image.imageData = merged;
    image.type = "rgb";
  }

  static handleJPEGImage(tags, image) {
    const bitsPerSample = tags["BitsPerSample"];
    const smaplesPerPixel = bitsPerSample.length;
    const photometInterp = tags["PhotometricInterpretation"][0];

    if (
      (photometInterp === PhotometricInterp.YCBCR &&
        smaplesPerPixel == 3 &&
        bitsPerSample[0] === 8) ||
      (photometInterp === PhotometricInterp.BLACK_IS_ZERO &&
        smaplesPerPixel == 1 &&
        bitsPerSample[0] === 8)
    ) {
      // baseline DCT JPEG
      image.type = "jpeg";
      image.imageData = image.strips[0];
    }
  }

  static handleZIPImage(tags, image) {
  }

  static handleLossyJPEGImage(tags, image) {
  }

  static parseIFD(file, byteOffset) {
    const littleEndian = file._littleEndian ?? true;
    const directoryHeader = this.unserialize(
      file,
      byteOffset,
      this.DirectoryHeader
      ,
      littleEndian
    );

    const fieldCount = this.getValue(directoryHeader, "entryCount");
    const tags = this.parseTags(file, byteOffset + 2, fieldCount, littleEndian);

    return {
      tags: tags,
      next: this.parseBytes(
        file.view,
        byteOffset + 2 + fieldCount * 12,
        "unsigned int",
        littleEndian
      ).valueOf(),
    };
  }

  static parseTags(file, ifdOffset, count, littleEndian = true) {
    const tags = {};

    for (
      let offset = ifdOffset;
      offset < ifdOffset + count * 12;
      offset += 12
    ) {
      const entry = this.unserialize(file, offset, this.Entry, littleEndian);

      let tag = this.getValue(entry, "tag");
      let typeIndex = this.getValue(entry, "type") - 1;
      let type = this.FIELD_TYPE[Object.keys(this.FIELD_TYPE)[typeIndex]];
      let count = this.getValue(entry, "count");
      let valueOffset = this.getValue(entry, "valueOffset");
      let data = null;
      let field = null;

      for (let fieldType of this.FIELDS) {
        if (fieldType.tag === tag) {
          field = fieldType;
        }
      }

      if (!field) {
        continue;
      }

      const dataType = type.type;
      const typeByteLength = BinaryFile.getTypeBytelength(dataType);

      // see if value fits into the 4 bytes value
      if (count * typeByteLength <= 4) {
        valueOffset = entry.byteOffset - 4;
      }

      switch (type) {
        case this.FIELD_TYPE.ASCII:
          const asciiValue = this.unserializeArray(
            file,
            valueOffset,
            { value: "char" },
            count,
            littleEndian
          );
          const stringArray = asciiValue
            .map((v) => v.valueOf().value)
            .map((v) => v.valueOf());
          data = stringArray.slice(0, stringArray.length - 1).join("");
          break;

        case this.FIELD_TYPE.SRATIONAL:
        case this.FIELD_TYPE.RATIONAL:
          const rationalValue = this.unserializeArray(
            file,
            valueOffset,
            { value1: dataType, value2: dataType },
            count,
            littleEndian
          );

          data = rationalValue.map((v) => {
            return [v.valueOf().value1.valueOf(), v.valueOf().value2.valueOf()];
          });
          break;

        case this.FIELD_TYPE.UNDEFINED:
          // wont handle undefined tags
          data = undefined;
          break;

        default:
          const valueNumber = this.unserializeArray(
            file,
            valueOffset,
            { value: dataType },
            count,
            littleEndian
          );
          data = valueNumber.map((v) => v.valueOf().value.valueOf());
      }

      tags[field.name] = data;
    }

    return tags;
  }

  get type() { return "TIFF"; }
  get MAX_RES_IMAGE_INDEX() { return 0; }

  getTag(fieldId, subifd = 0) {
    return this._ifds[subifd][fieldId];
  }

  getXMPData() {
    const xmp = this.getTag("XMP");

    if (xmp && DOMParser && !this._xmp) {
      const xmlParser = new DOMParser();
      const xmldoc = xmlParser.parseFromString(xmp, "text/xml");
      this._xmp = xmldoc;
    }
    return this._xmp;
  }

  getXMPEntry(nodeName) {
    const xmp = this.getXMPData();

    for (let child of xmp.all) {
      if (child.localName.toLocaleLowerCase() == nodeName) {
        return child.innerHTML;
      }
    }
  }

  getDimesions() {
    return {
      resolutionX: this._tags["XResolution"][0],
      resolutionY: this._tags["YResolution"][0],
      resolutionUnit: this._tags["YResolution"][0],
    };
  }

  getImage(index = this.MAX_RES_IMAGE_INDEX) {
    return this._images[index];
  }

  getRenderableImage() {
    const decodableImages = this._images.filter((image) => image.type === "jpeg" || image.type === "rgb");
    if (decodableImages.length === 0) {
      throw new Error("no decodable TIFF image found");
    }
    decodableImages.sort((left, right) => {
      const leftArea = (left.width ?? 0) * (left.height ?? 0);
      const rightArea = (right.width ?? 0) * (right.height ?? 0);
      return rightArea - leftArea;
    });
    return decodableImages[0];
  }

  async getThumbnail() {
    const image = this.getRenderableImage();
    if (image.type === "jpeg") {
      return new Blob([image.imageData], { type: "image/jpeg" });
    }
    return new Blob([this.buffer], { type: "image/tiff" });
  }

  async getImageData() {
    const image = this.getRenderableImage();

    let imageObject = null;
    let rgbImageData = null;
    let format = "RGB";
    let bitsPerSample = 8;
    let width = 0;
    let height = 0;

    if (image.type == "jpeg") {
      const blob = new Blob([image.imageData], { type: "image/jpeg" });
      imageObject = await createImageBitmap(blob);

      width = imageObject.width;
      height = imageObject.height;

      const canvas = new ImageCanvas(imageObject.width, imageObject.height);
      const context = canvas.getContext("2d");
      context.drawImage(imageObject, 0, 0);

      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

      bitsPerSample = 8;
      format = "RGBA";
      rgbImageData = data;
    }

    if (image.type == "rgb") {
      bitsPerSample = 8;
      width = image.width;
      height = image.height;
      rgbImageData = new Uint8Array(image.imageData);
    }

    const orientation = image.orientation;

    const container: RawImageData = new RawImageData({
      orientation,
      format,
      bitsPerSample,
      data: rgbImageData,
      width: width,
      height: height,
    });

    return container;
  }
}
