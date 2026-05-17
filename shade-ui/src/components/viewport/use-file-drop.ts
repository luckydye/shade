import { type Accessor, createSignal } from "solid-js";
import { useOpenImage } from "../../data/use-open-image";
import { state } from "../../store/editor-store";

export function useFileDrop(): {
  dragging: Accessor<boolean>;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => Promise<void>;
} {
  const [dragging, setDragging] = createSignal(false);

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!state.webgpuAvailable) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    try {
      for (const [index, file] of files.entries()) {
        await useOpenImage().openFile(file, index === 0 ? "replace" : "append");
      }
    } catch {
      // openImageFile reports errors via the store
    }
  };

  return { dragging, onDragOver, onDragLeave, onDrop };
}
