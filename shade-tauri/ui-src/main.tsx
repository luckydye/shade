import { createSignal, ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import App from "shade-ui/src/App";
import { setPlatform } from "shade-ui/src/bridge/index";
import { platform } from "./platform";

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
  setPlatform(platform);
  render(
    () => (
      fatalError() ? (
        <FatalErrorView message={fatalError()!} />
      ) : (
        <ErrorBoundary
          fallback={(error) => <FatalErrorView message={reportFatalError(error)} />}
        >
          <App />
        </ErrorBoundary>
      )
    ),
    root,
  );
} catch (error) {
  reportFatalError(error);
  throw error;
}
