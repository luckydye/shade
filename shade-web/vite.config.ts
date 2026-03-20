import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  base: "/app/",
  server: {
    port: 4173,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, "."), resolve(__dirname, "../ui")],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "dist",
    target: ["es2021", "chrome100", "safari13"],
  },
  worker: {
    format: "es",
  },
});
