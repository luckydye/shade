import { BinaryFile } from "../BinaryFile";
import RawImageData from "./RawImageData";
import TIFFFile from "./TIFF";

const UUID_PRVW = "eaf42b5e 1c98 4b88 b9fb b7dc406e4d16";
const UUID_MOOV = "85c0b687 820f 11e0 8111 f4ce462b6a48";

function matchUUID(uuid, UUID) {
  return uuid == UUID.replace(/\W/g, "");
}

const TAG_STRUCTS = {
  free: {},
  CNCV: {
    version: "char[30]",
  },
  CCTP: {
    zero: "byte",
    one: "byte",
    lines_count: "byte",
    lines: "CCDT[lines_count]",
  },
  CCDT: {
    size: "byte",
    tag: "char[4]",
    imageType: "byte",
    dualPixel: "byte",
    trackIndex: "byte",
  },
  CTBO: {
    recordsCount: "byte",
  },
  CMT1: {},
  CMT2: {},
  CMT3: {},
  CMT4: {},
  THMB: {
    version: "byte",
    flags: "byte[3]",
    width: "short",
    height: "short",
    imageByteSize: "long",
    unknown1: "short",
    unknown2: "short",
    imageData: "byte[imageByteSize]",
  },
};

export default class CR3File extends BinaryFile {
  static get BoxHeader() {
    return {
      size: "unsigned int",
      type: "char[4]",
    };
  }

  static get FileTypeBox() {
    return {
      filetype: "char[3]",
      version: "int",
      compat: "int",
    };
  }

  static get MoovBox() {
    return {
      idk: "int",
      uuidTag: "char[4]",
      uuid: "char[19]",
    };
  }

  static get TagEntry() {
    return {
      size: "byte",
      tag: "char[4]",
    };
  }

  static verifyFileHeader(file) {
    const fileTypeBox = CR3File.unserialize(file, 0, CR3File.BoxHeader, false);
    const fileTyp = CR3File.unserialize(
      file,
      fileTypeBox.byteOffset,
      CR3File.FileTypeBox,
      true,
    );

    if (CR3File.getValue(fileTyp, "filetype") == "crx") {
      return CR3File.getValue(fileTypeBox, "size");
    } else {
      throw new Error("File type not recognized");
    }
  }

  static parseFile(file) {
    // read file header
    const offset = CR3File.verifyFileHeader(file);
    CR3File.unserializeBoxes(file, offset);
  }

  static unserializeBoxes(file, offset) {
    const moovBox = CR3File.unserialize(file, offset, CR3File.BoxHeader, false);

    // const uuid = this.unserialize(file, previewBox.byteOffset, { uuid: 'byte[16]' });
    // const uuidData = this.getValue(uuid, 'uuid').map(v => v.toString(16)).join("");

    // const moov = this.unserialize(file, moovBox.byteOffset, this.MoovBox, false);
    // const tags = this.parseTags(file.view, moov.byteOffset, 3);
    // console.log(moov);

    const xpacketOffset = offset + CR3File.getValue(moovBox, "size");
    const xpacketBox = CR3File.unserialize(file, xpacketOffset, CR3File.BoxHeader, false);

    const previewOffset = xpacketOffset + CR3File.getValue(xpacketBox, "size");
    const previewBox = CR3File.unserialize(file, previewOffset, CR3File.BoxHeader, false);

    const uuid = CR3File.unserialize(file, previewBox.byteOffset, { uuid: "byte[16]" });
    const uuidData = CR3File.getValue(uuid, "uuid")
      .map((v) => v.toString(16))
      .join("");

    if (matchUUID(uuidData, UUID_PRVW)) {
      const entry = CR3File.unserialize(file, uuid.byteOffset, CR3File.PRVWTag, false);

      const imageData = CR3File.getValue(entry, "imageData");
      file.imageData = new Uint8Array(imageData);
    }

    // const freeOffset = previewOffset + this.getValue(previewBox, 'size');
    // const freeBox = this.unserialize(file, freeOffset, this.BoxHeader, false);
    // console.log('free', freeBox);

    // const mdatOffset = freeOffset + this.getValue(freeBox, 'size');
    // const mdatBox = this.unserialize(file, mdatOffset, this.BoxHeader, false);
    // console.log('mdat', mdatBox);

    // const whatOffset = mdatOffset + this.getValue(mdatBox, 'size');
    // const whatBox = this.unserialize(file, whatOffset, this.BoxHeader, false);
    // console.log('what', whatBox);

    // if(this.getValue(mdatBox, 'type') == 'mdat') {
    //   console.log(mdatBox);

    //   const mdat = this.unserialize(file, mdatBox.byteOffset, { data: 'byte[256]' });
    //   const imageData = this.getValue(mdat, "data");
    //   // file.imageData = new Uint8Array(imageData);
    // }
  }

  static get PRVWTag() {
    return {
      idk: "byte[11]",
      size: "byte",
      tag: "char[4]",
      unknown1: "short",
      unknown2: "short",
      unknown3: "short",
      width: "short",
      height: "short",
      dasd: "byte[2]",
      imageByteSize: "int",
      imageData: "byte[imageByteSize]",
    };
  }

  static parseTags(file, ifdOffset, count = 1) {
    const tags = {};

    let offset = ifdOffset;

    for (let i = 0; i < count; i++) {
      const entry = CR3File.unserialize(file, offset, CR3File.PRVWTag);

      const size = CR3File.getValue(entry, "size");
      const tagType = CR3File.getValue(entry, "tag");

      offset += size;

      const tagStruct = TAG_STRUCTS[tagType];

      if (!tagStruct) {
        throw new Error("failed parsing file");
      }

      tags[tagType] = CR3File.unserialize(file, entry.byteOffset, tagStruct);
    }

    return tags;
  }

  getImageData() {
    const container = new RawImageData({
      orientation: 0,
      format: "RGB",
      bitsPerSample: 16,
      data: [],
      width: 1,
      height: 1,
    });

    return container;
  }

  getThumbnail() {
    const blob = new Blob([this.imageData], { type: "image/jpeg" });
    return blob;
  }
}
