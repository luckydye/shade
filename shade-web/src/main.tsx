import { render } from "solid-js/web";
import "./main.css";
import App from "shade-ui/src/App";
import { setBrowserMediaPlatform } from "shade-ui/src/bridge/index";
import { setThumbnailBackend } from "shade-ui/src/bridge/thumbnail-backend";
import { browserMediaPlatform } from "./browser-media-platform";
import { browserThumbnailBackend } from "./browser-thumbnail-backend";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

setBrowserMediaPlatform(browserMediaPlatform);
setThumbnailBackend(browserThumbnailBackend);

render(() => <App />, root);
