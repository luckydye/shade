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

setPlatform(platform);

render(() => <App />, root);
