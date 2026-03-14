import { Hono } from "hono";
import { existsSync } from "fs";
import { join } from "path";

const WEB_DIST = join(import.meta.dir, "../../../dist/web");

export function createStaticRoutes() {
  const app = new Hono();

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Attempt to serve exact file
    const filePath = join(WEB_DIST, pathname);
    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file);
    }

    // SPA fallback — serve index.html
    const indexPath = join(WEB_DIST, "index.html");
    if (existsSync(indexPath)) {
      const file = Bun.file(indexPath);
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return c.text("Web UI not built. Run: bun run build:web", 404);
  });

  return app;
}
