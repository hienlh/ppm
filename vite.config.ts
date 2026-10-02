import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "path";
import { monacoDevAssets } from "./scripts/vite-monaco-dev-assets.ts";

export default defineConfig({
  plugins: [
    react(),
    // Without this the editor never paints under `bun dev:web` — see the plugin's own comment.
    monacoDevAssets(),
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
        // Monaco needs no exclusion here: `copy-monaco.ts` stages it into
        // `dist/web/assets/monaco/` *after* `vite build`, so nothing of it can
        // reach the manifest — it is cached on use by the `/assets/` route in
        // `sw.ts`, workers included.
        globPatterns: ["index.html", "manifest.webmanifest", "icon-*.svg", "assets/index-*.{js,css}"],
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
    // A font is never worth inlining. The whole reason a `@font-face` carries a
    // `unicode-range` is that it is fetched only for text that actually needs
    // it — base64 in the stylesheet turns that into an unconditional download,
    // inside the one file the service worker precaches. Under Vite's 4 KB
    // default, four subsets were being inlined into the shell, three of them
    // the *rarest* Nerd Font blocks (IEC power symbols, Pomicons).
    assetsInlineLimit: (file: string) => (file.endsWith(".woff2") ? false : undefined),
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Let the dynamic Mermaid import own its dependencies. A manual
          // vendor group absorbs shared helpers and makes Markdown import the
          // entire diagram engine even when the transcript contains no diagram.
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
    // Vite turns this on by itself when it sees an AI agent in the environment (CLAUDECODE,
    // AI_AGENT, ...), which is how PPM's dev server is usually started. Its client then
    // forwards unhandled rejections over the HMR socket without catching the send, so once
    // a tunnel drops that socket each failed send is itself an unhandled rejection: a tab
    // was measured spinning at ~87k rejections/s and 150% CPU until reloaded.
    forwardConsole: false,
    // trace-client.ts wraps console.*, so without this DevTools would name the wrapper as the
    // source of every log line instead of the code that logged it.
    sourcemapIgnoreList: (sourcePath) => sourcePath.includes("node_modules") || sourcePath.endsWith("lib/trace-client.ts"),
    proxy: {
      "/api": {
        target: process.env.PPM_DEV_API ?? "http://localhost:8081",
        // HTML preview CSP must refer to the browser-facing authority.
        changeOrigin: false,
      },
      "/ws": {
        target: process.env.PPM_DEV_API ?? "http://localhost:8081",
        ws: true,
      },
    },
    fs: {
      // A git worktree's `node_modules` is often a junction back to the main checkout's (to
      // avoid a second install), so its *real* path sits outside the worktree root that Vite's
      // default allow-list computes. A deep import resolved through the junction — a font, a
      // lazy chunk such as the design canvas's screenshot library — then 403s as if it were
      // missing. Trusting node_modules' own resolved target fixes that without widening the
      // allow-list to anything else on disk; where node_modules is a real directory (no
      // junction) this just repeats an already-allowed path.
      allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(resolve(process.cwd(), "node_modules"))],
    },
  },
});
