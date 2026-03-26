// vite.config.ts
import { resolve } from "node:path";
import { defineConfig } from "file:///Users/tihav/source/shade/shade-web/node_modules/vite/dist/node/index.js";
import solid from "file:///Users/tihav/source/shade/shade-web/node_modules/vite-plugin-solid/dist/esm/index.mjs";
import tailwindcss from "file:///Users/tihav/source/shade/shade-web/node_modules/@tailwindcss/vite/dist/index.mjs";
var __vite_injected_original_dirname = "/Users/tihav/source/shade/shade-web";
var vite_config_default = defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    dedupe: ["solid-js"]
  },
  clearScreen: false,
  base: "/shade/",
  server: {
    port: 4173,
    strictPort: true,
    fs: {
      allow: [resolve(__vite_injected_original_dirname, "."), resolve(__vite_injected_original_dirname, "../shade-ui")]
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  },
  build: {
    outDir: "dist/shade",
    target: ["es2021", "chrome100", "safari13"],
    minify: false
  },
  worker: {
    format: "es"
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvdGloYXYvc291cmNlL3NoYWRlL3NoYWRlLXdlYlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL3RpaGF2L3NvdXJjZS9zaGFkZS9zaGFkZS13ZWIvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL3RpaGF2L3NvdXJjZS9zaGFkZS9zaGFkZS13ZWIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCBzb2xpZCBmcm9tIFwidml0ZS1wbHVnaW4tc29saWRcIjtcbmltcG9ydCB0YWlsd2luZGNzcyBmcm9tIFwiQHRhaWx3aW5kY3NzL3ZpdGVcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW3NvbGlkKCksIHRhaWx3aW5kY3NzKCldLFxuICByZXNvbHZlOiB7XG4gICAgZGVkdXBlOiBbXCJzb2xpZC1qc1wiXSxcbiAgfSxcbiAgY2xlYXJTY3JlZW46IGZhbHNlLFxuICBiYXNlOiBcIi9zaGFkZS9cIixcbiAgc2VydmVyOiB7XG4gICAgcG9ydDogNDE3MyxcbiAgICBzdHJpY3RQb3J0OiB0cnVlLFxuICAgIGZzOiB7XG4gICAgICBhbGxvdzogW3Jlc29sdmUoX19kaXJuYW1lLCBcIi5cIiksIHJlc29sdmUoX19kaXJuYW1lLCBcIi4uL3NoYWRlLXVpXCIpXSxcbiAgICB9LFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ3Jvc3MtT3JpZ2luLU9wZW5lci1Qb2xpY3lcIjogXCJzYW1lLW9yaWdpblwiLFxuICAgICAgXCJDcm9zcy1PcmlnaW4tRW1iZWRkZXItUG9saWN5XCI6IFwicmVxdWlyZS1jb3JwXCIsXG4gICAgfSxcbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICBvdXREaXI6IFwiZGlzdC9zaGFkZVwiLFxuICAgIHRhcmdldDogW1wiZXMyMDIxXCIsIFwiY2hyb21lMTAwXCIsIFwic2FmYXJpMTNcIl0sXG4gICAgbWluaWZ5OiBmYWxzZVxuICB9LFxuICB3b3JrZXI6IHtcbiAgICBmb3JtYXQ6IFwiZXNcIixcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEyUixTQUFTLGVBQWU7QUFDblQsU0FBUyxvQkFBb0I7QUFDN0IsT0FBTyxXQUFXO0FBQ2xCLE9BQU8saUJBQWlCO0FBSHhCLElBQU0sbUNBQW1DO0FBS3pDLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLEdBQUcsWUFBWSxDQUFDO0FBQUEsRUFDaEMsU0FBUztBQUFBLElBQ1AsUUFBUSxDQUFDLFVBQVU7QUFBQSxFQUNyQjtBQUFBLEVBQ0EsYUFBYTtBQUFBLEVBQ2IsTUFBTTtBQUFBLEVBQ04sUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osSUFBSTtBQUFBLE1BQ0YsT0FBTyxDQUFDLFFBQVEsa0NBQVcsR0FBRyxHQUFHLFFBQVEsa0NBQVcsYUFBYSxDQUFDO0FBQUEsSUFDcEU7QUFBQSxJQUNBLFNBQVM7QUFBQSxNQUNQLDhCQUE4QjtBQUFBLE1BQzlCLGdDQUFnQztBQUFBLElBQ2xDO0FBQUEsRUFDRjtBQUFBLEVBQ0EsT0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsUUFBUSxDQUFDLFVBQVUsYUFBYSxVQUFVO0FBQUEsSUFDMUMsUUFBUTtBQUFBLEVBQ1Y7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLFFBQVE7QUFBQSxFQUNWO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
