import { Component } from "solid-js";
import Toolbar from "./components/Toolbar";
import Inspector from "./components/Inspector";
import Canvas from "./components/Canvas";

const App: Component = () => {
  return (
    <div class="flex h-screen w-screen select-none flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_24%),linear-gradient(180deg,_#050505_0%,_#0c0c0c_100%)] text-stone-100">
      <Toolbar />
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <Canvas />
        <Inspector />
      </div>
    </div>
  );
};

export default App;
