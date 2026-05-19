import type { Accessor, Setter } from "solid-js";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { listenNativeDragDrop } from "../../data/use-native-drag-drop";
import { useMediaUploadProgress } from "../../data/use-media-upload-progress";
import { isTauriRuntime } from "../../utils";
import { filenameFromUrl, transformImageUrl } from "./url-transformers";
import {
  clipboardImageFiles,
  draggedItemCount,
  draggedPathCount,
  droppedFiles,
  isS3Library,
  libraryIsWritable,
  targetAcceptsTextInput,
  type LibraryEntry,
  type UploadDragFeedback,
} from "./media-utils";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMediaUploadHandlers(params: {
  selectedLibrary: Accessor<LibraryEntry | null>;
  canWriteSelectedLibrary: Accessor<boolean>;
  isSubmitting: Accessor<boolean>;
  setIsSubmitting: Setter<boolean>;
  setError: Setter<string | null>;
  uploadMediaLibraryFile: (
    libraryId: string,
    file: File,
    appendTimestampOnConflict?: boolean,
  ) => Promise<unknown>;
  uploadMediaLibraryPath: (libraryId: string, path: string) => Promise<unknown>;
  uploadMediaLibraryUrl: (
    libraryId: string,
    url: string,
    fileName: string,
  ) => Promise<unknown>;
  refreshLibraryIndex: (libraryId: string) => Promise<unknown>;
  refetchCachedLibraryItems: () => unknown;
  refetchItems: () => unknown;
}) {
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
    if (params.canWriteSelectedLibrary()) {
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
      await params.refreshLibraryIndex(library.id);
    }
    await params.refetchCachedLibraryItems();
    await params.refetchItems();
  }

  async function handleUploadLibraryFiles(
    files: File[],
    appendTimestampOnConflict = false,
  ) {
    const library = params.selectedLibrary();
    if (!library || !libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (files.length === 0) {
      return;
    }
    if (params.isSubmitting()) {
      params.setError("media library operation already in progress");
      return;
    }
    params.setIsSubmitting(true);
    params.setError(null);
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: files.length,
          completedFiles: index,
          currentFileName: file.name,
        });
        await params.uploadMediaLibraryFile(
          library.id,
          file,
          appendTimestampOnConflict,
        );
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: files.length,
        completedFiles: files.length,
        currentFileName: null,
      });
      if (isS3Library(library)) {
        await params.refreshLibraryIndex(library.id);
      }
      await params.refetchCachedLibraryItems();
      await params.refetchItems();
    } catch (err) {
      params.setError(toErrorMessage(err));
    } finally {
      setUploadProgress(null);
      params.setIsSubmitting(false);
    }
  }

  async function handleUploadLibraryPaths(paths: string[]) {
    const library = params.selectedLibrary();
    if (!library || !libraryIsWritable(library)) {
      throw new Error("selected library is readonly");
    }
    if (paths.length === 0) {
      return;
    }
    if (params.isSubmitting()) {
      params.setError("media library operation already in progress");
      return;
    }
    params.setIsSubmitting(true);
    params.setError(null);
    try {
      for (const [index, path] of paths.entries()) {
        setUploadProgress({
          phase: "uploading",
          totalFiles: paths.length,
          completedFiles: index,
          currentFileName: path.split(/[/\\\\]/).pop() ?? path,
        });
        await params.uploadMediaLibraryPath(library.id, path);
      }
      setUploadProgress({
        phase: "refreshing",
        totalFiles: paths.length,
        completedFiles: paths.length,
        currentFileName: null,
      });
      if (isS3Library(library)) {
        await params.refreshLibraryIndex(library.id);
      }
      await params.refetchCachedLibraryItems();
      await params.refetchItems();
    } catch (err) {
      params.setError(toErrorMessage(err));
    } finally {
      setUploadProgress(null);
      params.setIsSubmitting(false);
    }
  }

  async function handleUploadFromUrl(fetchUrl: string, originalUrl: string) {
    const library = params.selectedLibrary();
    if (!library || !libraryIsWritable(library)) return;
    if (params.isSubmitting()) {
      params.setError("media library operation already in progress");
      return;
    }
    params.setIsSubmitting(true);
    params.setError(null);
    const fileName = filenameFromUrl(originalUrl);
    setUploadProgress({
      phase: "uploading",
      totalFiles: 1,
      completedFiles: 0,
      currentFileName: fileName,
    });
    try {
      await params.uploadMediaLibraryUrl(library.id, fetchUrl, fileName);
      await refreshAfterUpload(library);
    } catch (error) {
      params.setError(toErrorMessage(error));
    } finally {
      setUploadProgress(null);
      params.setIsSubmitting(false);
    }
  }

  function handleUploadDragEnter(event: DragEvent) {
    if (usesNativeDragDrop() || !params.canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback({
      itemCount: draggedItemCount(event.dataTransfer),
    });
  }

  function handleUploadDragOver(event: DragEvent) {
    if (usesNativeDragDrop() || !params.canWriteSelectedLibrary()) {
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
    if (
      !params.canWriteSelectedLibrary() ||
      usesNativeDragDrop() ||
      (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
    ) {
      return;
    }
    setUploadDragFeedback(null);
  }

  function handleUploadDrop(event: DragEvent) {
    if (usesNativeDragDrop() || !params.canWriteSelectedLibrary()) {
      return;
    }
    event.preventDefault();
    setUploadDragFeedback(null);
    const files = droppedFiles(event.dataTransfer);
    if (files.length === 0) {
      params.setError("drop did not contain files");
      return;
    }
    void handleUploadLibraryFiles(files);
  }

  function handleUploadPaste(event: ClipboardEvent) {
    if (!params.canWriteSelectedLibrary() || targetAcceptsTextInput(event.target)) {
      return;
    }
    let files: File[];
    try {
      files = clipboardImageFiles(event.clipboardData);
    } catch (error) {
      event.preventDefault();
      params.setError(toErrorMessage(error));
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
        if (!params.canWriteSelectedLibrary()) {
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
          params.setError("drop did not contain files");
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
