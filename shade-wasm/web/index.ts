// Re-export wasm bindings so consumers can `import init, * as wasm from "shade-wasm"`.
// The legacy `createShadeWorker` helper survives for any code that still
// spawns a dedicated shade.worker.ts — new code should host the wasm
// directly (see shade-web/src/worker.ts).
export { default } from "../pkg/shade_wasm.js";
export * from "../pkg/shade_wasm.js";

export function createShadeWorker() {
  return new Worker(new URL("./shade.worker.ts", import.meta.url), {
    type: "module",
  });
}
