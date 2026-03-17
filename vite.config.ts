import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import monacoEditorPlugin from "vite-plugin-monaco-editor";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ((monacoEditorPlugin as unknown as { default?: (opts: object) => object }).default ?? (monacoEditorPlugin as unknown as (opts: object) => object))({
      languages: ["javascript", "typescript", "python", "html", "css", "json", "markdown", "yaml", "shell"],
    }),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: ".",
      filename: "sw.ts",
      manifest: {
        name: "PPM — Personal Project Manager",
        short_name: "PPM",
        description: "Mobile-first web IDE for managing code projects",
        theme_color: "#0f1419",
        background_color: "#0f1419",
        display: "standalone",
        orientation: "any",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
    }),
  ],
  root: "src/web",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/web"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist/web"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:8081",
      "/ws": {
        target: "ws://localhost:8081",
        ws: true,
        // Disable timeout to prevent proxy from closing long-running WS connections
        timeout: 0,
      },
    },
  },
});
