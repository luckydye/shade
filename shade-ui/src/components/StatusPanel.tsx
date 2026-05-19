import { type Component, createMemo, Show } from "solid-js";
import { useBatchOperations } from "../data/use-batch-operations";
import { useLibrarySyncProgress } from "../data/use-library-sync-progress";
import { useMediaUploadProgress } from "../data/use-media-upload-progress";
import { useMediaViewStatus } from "../data/use-media-view-status";

type ProgressPanelProps = {
  title: string;
  completed: number;
  total: number;
  currentName: string | null;
};

const ProgressPanel: Component<ProgressPanelProps> = (props) => {
  const percent = () =>
    props.total > 0 ? Math.round((props.completed / props.total) * 100) : 0;

  return (
    <div class="rounded-xl border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--panel-bg)_92%,transparent)] px-3 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md">
      <div class="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--text)]">
        <span>{props.title}</span>
        <span class="text-[var(--text-dim)]">
          {props.completed}/{props.total}
        </span>
      </div>
      <Show when={props.currentName}>
        <p class="mt-1 overflow-hidden whitespace-nowrap text-ellipsis text-[12px] font-medium text-[var(--text-dim)]">
          {props.currentName}
        </p>
      </Show>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]">
        <div
          class="h-full rounded-full bg-[var(--border-active)] transition-[width] duration-150"
          style={{ width: `${percent()}%` }}
        />
      </div>
    </div>
  );
};

const ErrorPanel: Component<{ message: string }> = (props) => (
  <div class="rounded-xl border border-[var(--danger-border)] bg-[color-mix(in_srgb,var(--panel-bg)_94%,transparent)] px-3 py-2 text-[12px] font-medium text-[var(--danger-text)] shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md">
    {props.message}
  </div>
);

const MessagePanel: Component<{ message: string }> = (props) => (
  <div class="rounded-xl border border-[var(--border-medium)] bg-[color-mix(in_srgb,var(--panel-bg)_94%,transparent)] px-3 py-2 text-[12px] font-medium text-[var(--text-value)] shadow-[0_12px_32px_rgba(0,0,0,0.22)] backdrop-blur-md">
    {props.message}
  </div>
);

export const StatusPanel: Component = () => {
  const { exportProgress } = useBatchOperations();
  const syncProgress = useLibrarySyncProgress();
  const { uploadProgress } = useMediaUploadProgress();
  const { mediaViewActionStatus, mediaViewError } = useMediaViewStatus();
  const hasStatus = createMemo(
    () =>
      mediaViewActionStatus() !== null ||
      mediaViewError() !== null ||
      uploadProgress() !== null ||
      syncProgress() !== null ||
      exportProgress() !== null,
  );

  return (
    <Show when={hasStatus()}>
      <div class="pointer-events-none absolute bottom-4 right-4 z-30 flex w-[min(20rem,calc(100%-2rem))] flex-col gap-2">
        <Show when={mediaViewActionStatus()}>
          {(message) => <MessagePanel message={message()} />}
        </Show>
        <Show when={mediaViewError()}>
          {(message) => <ErrorPanel message={message()} />}
        </Show>
        <Show when={uploadProgress()}>
          {(progress) => (
            <ProgressPanel
              title={
                progress().phase === "uploading" ? "Uploading" : "Refreshing Library"
              }
              completed={progress().completedFiles}
              total={progress().totalFiles}
              currentName={progress().currentFileName}
            />
          )}
        </Show>
        <Show when={syncProgress()}>
          {(progress) => (
            <ProgressPanel
              title="Syncing Library"
              completed={progress().completed}
              total={progress().total}
              currentName={progress().current_name}
            />
          )}
        </Show>
        <Show when={exportProgress()}>
          {(progress) => (
            <ProgressPanel
              title="Exporting Images"
              completed={progress().completed}
              total={progress().total}
              currentName={progress().current_name}
            />
          )}
        </Show>
      </div>
    </Show>
  );
};
