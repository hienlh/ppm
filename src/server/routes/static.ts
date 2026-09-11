import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { resolve, join, extname, dirname } from "node:path";
import { isCompiledBinary } from "../../services/autostart-generator.ts";
import { chooseVariant } from "./static-encoding.ts";

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
      // The MIME type is the *original* file's even when a compressed copy is
      // sent — `Content-Encoding` describes the transfer, `Content-Type` the
      // content, and swapping them makes the browser download a file instead of
      // running it.
      const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      const variant = chooseVariant(filePath, c.req.header("Accept-Encoding"), existsSync);
      const headers: Record<string, string> = { "Content-Type": mime };
      if (variant.encoding) {
        headers["Content-Encoding"] = variant.encoding;
        // Without this a shared cache would hand a brotli body to a client that
        // never asked for one.
        headers["Vary"] = "Accept-Encoding";
      }
      // Vite emits content-hashed filenames under /assets/ — safe to cache forever.
      // Everything else gets revalidation via ETag so upgrades propagate.
      if (urlPath.startsWith("/assets/")) {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else {
        const stat = statSync(variant.path);
        // The encoding is part of the identity: two variants of one file are
        // different bytes, and an ETag they shared would let a cache answer a
        // gzip request with a brotli body.
        const suffix = variant.encoding ? `-${variant.encoding}` : "";
        const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}${suffix}"`;
        headers["Cache-Control"] = "no-cache";
        headers["ETag"] = etag;
        if (c.req.header("If-None-Match") === etag) {
          return new Response(null, { status: 304, headers });
        }
      }
      return new Response(variant.encoding ? Bun.file(variant.path) : file, { headers });
    }
  }

  // SPA fallback: serve index.html with revalidation so new asset hashes propagate
  const indexPath = resolve(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    const stat = statSync(indexPath);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { "Cache-Control": "no-cache", ETag: etag } });
    }
    c.header("Cache-Control", "no-cache");
    c.header("ETag", etag);
    return c.html(await Bun.file(indexPath).text());
  }
  return c.text("Frontend not built. Run: bun run build:web", 404);
});
