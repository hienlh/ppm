import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** The question card alone, styled by the app's own stylesheet, for `question-preview-e2e.mjs`. */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "../../../../src/web") } },
  build: { outDir: resolve(__dirname, "../../../../dist/e2e/question-preview"), emptyOutDir: true },
});
