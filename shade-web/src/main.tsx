import { render } from "solid-js/web";
import "./main.css";
import App from "shade-ui/src/App";
import {
  setBrowserMediaPlatform,
  setBrowserPresetsPlatform,
  setBrowserSnapshotsPlatform,
} from "shade-ui/src/bridge/index";
import { setThumbnailBackend } from "shade-ui/src/bridge/thumbnail-backend";
import { browserMediaPlatform } from "./browser-media-platform";
import { browserPresetsPlatform } from "./browser-presets-platform";
import { browserSnapshotsPlatform } from "./browser-snapshots-platform";
import { browserThumbnailBackend } from "./browser-thumbnail-backend";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

setBrowserMediaPlatform(browserMediaPlatform);
setBrowserPresetsPlatform(browserPresetsPlatform);
setBrowserSnapshotsPlatform(browserSnapshotsPlatform);
setThumbnailBackend(browserThumbnailBackend);

render(() => <App />, root);
