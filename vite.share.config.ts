import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

/**
 * The reviewer's page of a design share link (`/s/<code>`), built on its own.
 *
 * A separate config rather than a second input of `vite.config.ts`, because that config
 * carries the PWA plugin: it injects service worker registration and a manifest link into
 * the HTML it processes, and a reviewer's page must do neither. Nothing here does.
 *
 * It writes into the same `dist/web` the app build has just emptied (`emptyOutDir: false`),
 * the page to `design-share-page/index.html` (served only by the `/s` route, under its own
 * CSP) and everything else under `assets/share-*`, so the assets get the immutable cache
 * header and the compressed siblings but never enter the app's precache. No module preload
 * polyfill: the page's CSP is `script-src 'self'`, and the polyfill is the one thing Vite
 * might otherwise inline.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/web",
  publicDir: false,
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/web"),
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: false,
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(__dirname, "src/web/design-share-page/index.html"),
      output: {
        entryFileNames: "assets/share-[hash].js",
        chunkFileNames: "assets/share-[hash].js",
        assetFileNames: "assets/share-[hash][extname]",
      },
    },
  },
});
