import { type Accessor, createRoot, createSignal } from "solid-js";

export type MediaUploadProgress = {
  phase: "uploading" | "refreshing";
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
};

const uploadProgressState = createRoot(() => {
  const [progress, setProgress] = createSignal<MediaUploadProgress | null>(null);
  return { progress, setProgress };
});

export function useMediaUploadProgress(): {
  uploadProgress: Accessor<MediaUploadProgress | null>;
  setUploadProgress: (progress: MediaUploadProgress | null) => void;
} {
  return {
    uploadProgress: uploadProgressState.progress,
    setUploadProgress: uploadProgressState.setProgress,
  };
}
