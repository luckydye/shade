import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    dedupe: ["solid-js"],
  },
  clearScreen: false,
  base: "/app/",
  server: {
    port: 4173,
    strictPort: true,
    fs: {
      allow: [
        resolve(__dirname, "."),
        resolve(__dirname, "../shade-ui"),
        resolve(__dirname, "../shade-wasm"),
      ],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "dist/shade",
    target: ["es2021", "chrome100", "safari13"],
    minify: false
  },
  optimizeDeps: {
    exclude: ["shade-ui", "shade-wasm"],
  },
  worker: {
    format: "es",
  },
});
