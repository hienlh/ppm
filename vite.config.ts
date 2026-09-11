import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
        // The shell only. Globbing everything meant a phone's first visit
        // downloaded 488 files and 33.3 MB before the app was usable; the rest
        // is content-hashed and immutable, so `sw.ts` caches it on first real
        // use instead. `index-*` is Vite's entry chunk.
        // Named individually rather than by extension: a `*.png` glob pulled in
        // `donate-qr.png`, 104 KB downloaded before first paint by everyone.
        globPatterns: ["index.html", "manifest.webmanifest", "icon-*.svg", "assets/index-*.{js,css}"],
        // Belt and braces: the Monaco workers must never come back into the
        // precache, whatever the patterns above grow into.
        globIgnores: ["**/monacoeditorwork/**"],
        // No shell file is anywhere near this. A cap in the megabytes is what
        // let a 12.7 MB worker in.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
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
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
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
      "/api": process.env.PPM_DEV_API ?? "http://localhost:8081",
      "/ws": {
        target: process.env.PPM_DEV_API ?? "http://localhost:8081",
        ws: true,
      },
    },
  },
});
