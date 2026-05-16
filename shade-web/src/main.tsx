import { render } from "solid-js/web";
import "./main.css";
import App from "shade-ui/src/App";
import { installCoordinationChannelFromTransport } from "shade-ui/src/bridge/channel";
import { setHostHooks } from "shade-ui/src/bridge/host";
import { setTransport } from "shade-ui/src/bridge/transport";
import { webHostHooks } from "./web-host-hooks";
import { createWorkerTransport } from "./worker-transport";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

setTransport(createWorkerTransport());
setHostHooks(webHostHooks);
void installCoordinationChannelFromTransport();

render(() => <App />, root);
