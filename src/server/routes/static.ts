import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const staticRoutes = new Hono();

const DIST_DIR = resolve(import.meta.dir, "../../../dist/web");

/** Serve static files from dist/web/ with SPA fallback */
staticRoutes.use(
  "*",
  serveStatic({
    root: existsSync(DIST_DIR) ? DIST_DIR : undefined,
    rewriteRequestPath: (path) => path,
  }),
);

/** SPA fallback — serve index.html for all unmatched routes */
staticRoutes.get("*", (c) => {
  const indexPath = resolve(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    return c.html(Bun.file(indexPath).text());
  }
  return c.text("Frontend not built. Run: bun run build:web", 404);
});
