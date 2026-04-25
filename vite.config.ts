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
          { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
          { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
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
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/monaco-editor")) return "vendor-monaco";
          if (id.includes("node_modules/mermaid")) return "vendor-mermaid";
          if (id.includes("node_modules/@xterm")) return "vendor-xterm";
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/rehype-katex") ||
            id.includes("node_modules/rehype-highlight") ||
            id.includes("node_modules/remark-gfm") ||
            id.includes("node_modules/remark-math")
          ) return "vendor-markdown";
          if (id.includes("node_modules/@radix-ui")) return "vendor-ui";
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:8081",
      "/ws": {
        target: "http://localhost:8081",
        ws: true,
      },
    },
  },
});
