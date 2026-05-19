import { Channel, invoke } from "@tauri-apps/api/core";
import App from "shade-ui/src/App";
import { installCoordinationChannelFromTransport } from "shade-ui/src/bridge/channel";
import { setHostHooks } from "shade-ui/src/bridge/host";
import { installPreviewChannel } from "shade-ui/src/bridge/preview";
import { setTransport } from "shade-ui/src/bridge/transport";
import { createSignal, ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { startRemoteControlBridge } from "./remote-control";
import { tauriHostHooks } from "./tauri-host-hooks";
import { createTauriTransport } from "./tauri-transport";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

if (/\bMac\b/i.test(navigator.userAgent)) {
  document.documentElement.dataset.tauriMacos = "true";
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join("\n\n");
  }
  return String(error);
}

const [fatalError, setFatalError] = createSignal<string | null>(null);

function FatalErrorView(props: { message: string }) {
  return (
    <pre
      style={{
        margin: "0",
        padding: "16px",
        width: "100vw",
        height: "100vh",
        overflow: "auto",
        background: "#111",
        color: "#f5f5f5",
        font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        "white-space": "pre-wrap",
      }}
    >
      {props.message}
    </pre>
  );
}

function reportFatalError(error: unknown) {
  console.error(error);
  
  const message = formatError(error);
  setFatalError(message);
  return message;
}

window.addEventListener("error", (event) => {
  reportFatalError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportFatalError(event.reason);
});

try {
  setTransport(createTauriTransport());
  setHostHooks(tauriHostHooks);
  void installCoordinationChannelFromTransport().catch(reportFatalError);
  void installPreviewChannel(async (handler) => {
    const channel = new Channel<ArrayBuffer>((buffer) => {
      if (buffer instanceof ArrayBuffer) handler(buffer);
    });
    await invoke("register_preview_channel", { channel });
  }).catch(reportFatalError);
  
  void startRemoteControlBridge().catch(reportFatalError);
  
  render(
    () => (
      <ErrorBoundary
        fallback={(error) => {
          const message = formatError(error);
          queueMicrotask(() => setFatalError(message));
          return <FatalErrorView message={message} />;
        }}
      >
        <App />
      </ErrorBoundary>
    ),
    root,
  );
} catch (error) {
  reportFatalError(error);
  throw error;
}
