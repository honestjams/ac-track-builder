import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works from any static host or subfolder
  // (GitHub Pages, Netlify, or straight off disk via `vite preview`).
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
