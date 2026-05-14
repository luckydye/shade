// Re-export wasm bindings so consumers can `import init, * as wasm from "shade-wasm"`.
export { default } from "../pkg/shade_wasm.js";
export * from "../pkg/shade_wasm.js";
