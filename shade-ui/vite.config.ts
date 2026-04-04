import { defineConfig } from "vite";
import { resolve } from "node:path";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import terminal from "vite-plugin-terminal";

export default defineConfig({
  plugins: [solid(), tailwindcss(), terminal({ output: ["terminal", "console"] })],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, "."), resolve(__dirname, "../shade-wasm")],
    },
    watch: { ignored: ["**/src-tauri/**"] },
    headers: {
      // Required for SharedArrayBuffer (used by wgpu/WASM threading)
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "dist",
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  optimizeDeps: {
    exclude: ["shade-wasm"],
  },
  worker: {
    format: "es",
  },
});
