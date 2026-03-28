import { render } from "solid-js/web";
import "./main.css";
import App from "shade-ui/src/App";
import {
  browserThumbnailBackend,
  setThumbnailBackend,
} from "shade-ui/src/bridge/thumbnail-backend";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

setThumbnailBackend(browserThumbnailBackend);

render(() => <App />, root);
