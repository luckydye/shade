/**
 * Host-thread capabilities that can't be carried over the message transport.
 *
 * DOM APIs that require a user gesture (file pickers, drag/drop) and any
 * external `BrowserFileHandle`-like resources must execute on the consumer's
 * main thread. `HostHooks` is the tiny surface where shade-ui exposes those
 * to the consumer.
 */

export type DragDropPayloadType = "enter" | "over" | "drop" | "leave";

export interface NativeDragDropPayload {
  type: DragDropPayloadType;
  paths: string[];
}

export interface HostHooks {
  /** Pick a directory. `null` if the user cancelled. */
  pickDirectory(): Promise<string | null>;
  /** Pick an export-target file. `null` if the user cancelled. */
  pickExportTarget(): Promise<string | null>;
  /** Subscribe to native drag/drop events. Returns an unsubscribe fn. */
  listenNativeDragDrop(
    listener: (payload: NativeDragDropPayload) => void,
  ): Promise<() => void>;
}

let _host: HostHooks | null = null;

export function setHostHooks(hooks: HostHooks): void {
  _host = hooks;
}

export function getHostHooks(): HostHooks {
  if (!_host) {
    throw new Error("host hooks not installed");
  }
  return _host;
}
