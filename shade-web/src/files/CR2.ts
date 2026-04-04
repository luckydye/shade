import DNGFile from "./DNG";

export default class CR2File extends DNGFile {
  get type() { return "CR2"; }

  static handleJPEGImage(tags, image) {
    image.imageData = image.strips[0];
    image.type = "jpeg";
  }

  async getThumbnail() {
    return new Blob([this._images[0].imageData], { type: "image/png" });
  }
}
