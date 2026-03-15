import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import terminal from "vite-plugin-terminal";

export default defineConfig({
	plugins: [
		solid(),
		tailwindcss(),
		terminal({ output: ["terminal", "console"] }),
	],
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
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
		exclude: ["shade_wasm"], // Don't pre-bundle the WASM module
	},
	worker: {
		format: "es",
	},
});
