import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import monacoEditorPlugin from "vite-plugin-monaco-editor";
import { resolve } from "path";
import { createConnection } from "net";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

/**
 * Custom WebSocket proxy plugin.
 *
 * Replaces http-proxy's built-in WS proxy (which relies on socket.pipe())
 * because Bun on Windows doesn't correctly pipe client→server data when the
 * connection arrives through a Cloudflare tunnel.  Using explicit 'data'
 * event handlers instead of .pipe() fixes the issue.
 */
function wsProxy(targetPort: number): Plugin {
  return {
    name: "ws-proxy",
    configureServer(server) {
      server.httpServer?.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = req.url ?? "";
          if (!url.startsWith("/ws/")) return;

          const target = createConnection(
            { port: targetPort, host: "localhost" },
            () => {
              const headerLines = Object.entries(req.headers)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
                .join("\r\n");
              target.write(
                `GET ${url} HTTP/${req.httpVersion}\r\n${headerLines}\r\n\r\n`,
              );
              if (head && head.length > 0) target.write(head);

              socket.on("data", (chunk: Buffer) => {
                if (!target.destroyed) target.write(chunk);
              });
              target.on("data", (chunk: Buffer) => {
                if (!socket.destroyed) socket.write(chunk);
              });

              socket.on("close", () => {
                if (!target.destroyed) target.destroy();
              });
              target.on("close", () => {
                if (!socket.destroyed) socket.destroy();
              });
              socket.on("error", () => {
                if (!target.destroyed) target.destroy();
              });
              target.on("error", () => {
                if (!socket.destroyed) socket.destroy();
              });
            },
          );

          target.on("error", () => {
            if (!socket.destroyed) socket.destroy();
          });
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [
    wsProxy(8081),
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
    },
  },
});
