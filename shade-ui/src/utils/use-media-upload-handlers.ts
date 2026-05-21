import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  clipboardImageFiles,
  draggedItemCount,
  draggedPathCount,
  droppedFiles,
  isS3Library,
  type LibraryEntry,
  libraryIsWritable,
  targetAcceptsTextInput,
  type UploadDragFeedback,
} from "../components/media-view/media-utils";
import { useMediaViewStore } from "./media-view-store";
import {
  filenameFromUrl,
  transformImageUrl,
} from "../components/media-view/url-transformers";
import { isTauriRuntime } from "../utils";
import { useMediaUploadProgress } from "./use-media-upload-progress";
import { listenNativeDragDrop } from "./use-native-drag-drop";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaUploadHandlers() {
  const store = useMediaViewStore();
  const [uploadDragFeedback, setUploadDragFeedback] =
    createSignal<UploadDragFeedback | null>(null);
  const [usesNativeDragDrop, setUsesNativeDragDrop] = createSignal(false);
  const { setUploadProgress } = useMediaUploadProgress();

  const isUploadDragActive = createMemo(() => uploadDragFeedback() !== null);
  const uploadDragLabel = createMemo(() => {
    const feedback = uploadDragFeedback();
    if (!feedback) {
      return "";
    }
    if (feedback.itemCount === null) {
      return "Drop Files To Upload";
    }
    return feedback.itemCount === 1
      ? "Drop 1 File To Upload"
      : `Drop ${feedback.itemCount} Files To Upload`;
  });

  createEffect(() => {
    if (store.canWriteSelectedLibrary()) {
      return;
    }
    setUploadDragFeedback(null);
  });

  async function refreshAfterUpload(library: LibraryEntry) {
    setUploadProgress({
      phase: "refreshing",
      totalFiles: 1,
      completedFiles: 1,
      currentFileName: null,
    });
    if (isS3Library(library)) {
      await store.refreshLibraryIndex(library.id);
    }
    await store.refetchItems();
  }

  async function handleUploadLibraryFiles(
    files: File[],
    appendTimestampOnConflict = false,
  ) {
    const library = store.selectedLibrary();
    if (!library || !libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (files.length === 0) {
      return;
    }
    if (store.isSubmitting()) {
      store.setError("media library operation already in progress");
      return;
    }
    store.setIsSubmitting(true);
    store.setError(null);
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: files.length,
          completedFiles: index,
          currentFileName: file.name,
        });
        await store.uploadMediaLibraryFile(library.id, file, appendTimestampOnConflict);
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: files.length,
        completedFiles: files.length,
        currentFileName: null,
      });
      if (isS3Library(library)) {
        await store.refreshLibraryIndex(library.id);
      }
      await store.refetchItems();
    } catch (err) {
      store.setError(toErrorMessage(err));
    } finally {
      setUploadProgress(null);
      store.setIsSubmitting(false);
    }
  }

  async function handleUploadLibraryPaths(paths: string[]) {
    const library = store.selectedLibrary();
    if (!library || !libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (paths.length === 0) {
      return;
    }
    if (store.isSubmitting()) {
      store.setError("media library operation already in progress");
      return;
    }
    store.setIsSubmitting(true);
    store.setError(null);
    try {
      for (const [index, path] of paths.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: paths.length,
          completedFiles: index,
          currentFileName: path.split(/[/\\\\]/).pop() ?? path,
        });
        await store.uploadMediaLibraryPath(library.id, path);
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: paths.length,
        completedFiles: paths.length,
        currentFileName: null,
      });
      if (isS3Library(library)) {
        await store.refreshLibraryIndex(library.id);
      }
      await store.refetchItems();
    } catch (err) {
      store.setError(toErrorMessage(err));
    } finally {
      setUploadProgress(null);
      store.setIsSubmitting(false);
    }
  }

  async function handleUploadFromUrl(fetchUrl: string, originalUrl: string) {
    const library = store.selectedLibrary();
    if (!library || !libraryIsWritable(library)) return;
    if (store.isSubmitting()) {
      store.setError("media library operation already in progress");
      return;
    }
    store.setIsSubmitting(true);
    store.setError(null);
    const fileName = filenameFromUrl(originalUrl);
    setUploadProgress({
      phase: "uploading",
      totalFiles: 1,
      completedFiles: 0,
      currentFileName: fileName,
    });
    try {
      await store.uploadMediaLibraryUrl(library.id, fetchUrl, fileName);
      await refreshAfterUpload(library);
    } catch (error) {
      store.setError(toErrorMessage(error));
    } finally {
      setUploadProgress(null);
      store.setIsSubmitting(false);
    }
  }

  function handleUploadDragEnter(event: DragEvent) {
    if (usesNativeDragDrop() || !store.canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback({
      itemCount: draggedItemCount(event.dataTransfer),
    });
  }

  function handleUploadDragOver(event: DragEvent) {
    if (usesNativeDragDrop() || !store.canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    setUploadDragFeedback({
      itemCount: draggedItemCount(event.dataTransfer),
    });
  }

  function handleUploadDragLeave(event: DragEvent) {
    if (!store.canWriteSelectedLibrary() || usesNativeDragDrop()) {
      return;
    }
    if (event.relatedTarget !== null) {
      return;
    }
    setUploadDragFeedback(null);
  }

  function handleUploadDrop(event: DragEvent) {
    if (usesNativeDragDrop() || !store.canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback(null);
    const files = droppedFiles(event.dataTransfer);
    if (files.length === 0) {
      store.setError("drop did not contain files");
      return;
    }
    void handleUploadLibraryFiles(files);
  }

  function handleUploadPaste(event: ClipboardEvent) {
    if (!store.canWriteSelectedLibrary() || targetAcceptsTextInput(event.target)) {
      return;
    }
    let files: File[];
    try {
      files = clipboardImageFiles(event.clipboardData);
    } catch (error) {
      event.preventDefault();
      store.setError(toErrorMessage(error));
      return;
    }
    if (files.length > 0) {
      event.preventDefault();
      void handleUploadLibraryFiles(files, true);
      return;
    }
    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (!text) return;
    const imageUrl = transformImageUrl(text);
    if (!imageUrl) return;
    event.preventDefault();
    void handleUploadFromUrl(imageUrl, text);
  }

  onMount(() => {
    let unlisten: (() => void) | null = null;
    if (isTauriRuntime()) {
      setUsesNativeDragDrop(true);
      void listenNativeDragDrop((payload) => {
        if (!store.canWriteSelectedLibrary()) {
          setUploadDragFeedback(null);
          return;
        }
        if (payload.type === "leave") {
          setUploadDragFeedback(null);
          return;
        }
        if (payload.type === "enter") {
          setUploadDragFeedback({
            itemCount: draggedPathCount(payload.paths),
          });
          return;
        }
        if (payload.type === "over") {
          setUploadDragFeedback((current) => current ?? { itemCount: null });
          return;
        }
        setUploadDragFeedback(null);
        if (payload.paths.length === 0) {
          store.setError("drop did not contain files");
          return;
        }
        void handleUploadLibraryPaths(payload.paths);
      }).then((u) => {
        unlisten = u;
      });
    }
    onCleanup(() => {
      unlisten?.();
    });
  });

  return {
    isUploadDragActive,
    uploadDragLabel,
    handleUploadDragEnter,
    handleUploadDragOver,
    handleUploadDragLeave,
    handleUploadDrop,
    handleUploadPaste,
  };
}
