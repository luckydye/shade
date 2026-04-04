import DNGFile from "./DNG";

export default class NEFFile extends DNGFile {
  get type() { return "NEF"; }

  static handleJPEGImage(tags, image) {
    image.type = "jpeg";
  }

  async getThumbnail() {
    return new Blob([this._images[3].imageData], { type: "image/png" });
  }
}
