import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: vercel(),
  site: "https://shade.luckydye.dev/",
  vite: {
    plugins: [tailwindcss()],
  },
});
