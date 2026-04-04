import { BinaryFile } from "../BinaryFile";

export default class JPEGFile extends BinaryFile {

  static parseFile(file) {
    // read file header
    
  }

  static async decompress(data, { width = 0, height = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([ data ]);

      const reader = new FileReader();
      reader.onloadend = function() {
          const img = new Image();
          
          img.src = reader.result;
          if(width) {
            img.width = width;
          }
          if(height) {
            img.height = height;
          }
          
          img.onload = () => {
            resolve(img);
          }
      }
      reader.readAsDataURL(blob); 
    })
  }

  async getThumbnail() {
      return new Blob([this.buffer], { type: "image/jpg" });
  }

}
