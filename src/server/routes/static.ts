import { Hono } from "hono";
import { existsSync } from "node:fs";
import { resolve, join, extname, dirname } from "node:path";
import { isCompiledBinary } from "../../services/autostart-generator.ts";

export const staticRoutes = new Hono();

// Compiled binary: look for web/ next to the binary itself
// Dev mode: resolve relative to source file
const DIST_DIR = isCompiledBinary()
  ? resolve(dirname(process.execPath), "web")
  : resolve(import.meta.dir, "../../../dist/web");

/** MIME types for common static assets */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/**
 * Serve static files from dist/web/ using Bun.file() directly.
 * Avoids hono/bun serveStatic which has path issues on Windows.
 * Falls back to index.html for SPA routing.
 */
staticRoutes.get("*", async (c) => {
  if (!existsSync(DIST_DIR)) {
    return c.text("Frontend not built. Run: bun run build:web", 404);
  }

  // Try to serve the requested file
  const urlPath = new URL(c.req.url).pathname;
  const filePath = join(DIST_DIR, urlPath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(DIST_DIR)) {
    return c.text("Forbidden", 403);
  }

  if (existsSync(filePath) && !filePath.endsWith("/") && !filePath.endsWith("\\")) {
    const file = Bun.file(filePath);
    // Only serve if it's actually a file (not directory)
    if (file.size > 0 || extname(filePath)) {
      const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      return new Response(file, { headers: { "Content-Type": mime } });
    }
  }

  // SPA fallback: serve index.html
  const indexPath = resolve(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    return c.html(await Bun.file(indexPath).text());
  }
  return c.text("Frontend not built. Run: bun run build:web", 404);
});
