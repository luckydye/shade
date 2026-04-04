import DNGFile from "./DNG";

export default class ARWFile extends DNGFile {
  get type() { return "ARW"; }

  static handleJPEGImage(tags, image) {
    image.type = "jpeg";
  }

  async getThumbnail() {
    return new Blob([this._images[0].imageData], { type: "image/jpeg" });
  }
}
