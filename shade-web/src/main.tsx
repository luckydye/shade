import { render } from "solid-js/web";
import "./main.css";
import App from "shade-ui/src/App";

const root = document.getElementById("root");

if (!(root instanceof HTMLElement)) {
  throw new Error("root element not found");
}

render(() => <App />, root);
