import type { ActionDef } from "../store/actions";
import { state } from "../store/editor-store";
import { useOpenImage } from "../utils/use-open-image";

const MEDIA_FILE_ACCEPT =
  "image/jpeg,image/png,image/tiff,image/webp,image/avif,image/x-exr,.exr,.3fr,.ari,.arw,.cr2,.cr3,.crm,.crw,.dcr,.dcs,.dng,.erf,.fff,.iiq,.kdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.ori,.pef,.qtk,.raf,.raw,.rw2,.rwl,.srw,.x3f";

export const ToolbarOpen = {
  id: "toolbar.open",
  title: "Open",
  group: "Toolbar",
  when: () => state.webgpuAvailable,
  run: () => {
    const image = useOpenImage();
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = MEDIA_FILE_ACCEPT;
    input.addEventListener(
      "change",
      () => {
        const files = input.files;
        if (!files || files.length === 0) return;
        void (async () => {
          for (const [index, file] of Array.from(files).entries()) {
            await image.openFile(file, index === 0 ? "replace" : "append");
          }
        })();
      },
      { once: true },
    );
    input.click();
  },
} satisfies ActionDef;
