import type { Context, Next } from "hono";
import { configService } from "../../services/config.service.ts";
import { consumeDownloadToken } from "../../services/download-token.service.ts";
import { err } from "../../types/api.ts";

/** Auth middleware — checks Bearer token against config */
export async function authMiddleware(c: Context, next: Next) {
  const authConfig = configService.get("auth");

  // Skip auth if disabled
  if (!authConfig.enabled) {
    return next();
  }

  // Allow health check without auth
  if (c.req.path === "/api/health") {
    return next();
  }

  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    if (token === authConfig.token) {
      return next();
    }
  }

  // Fallback: ?token= query param for SSE/EventSource (can't set custom headers)
  // Scoped to /stream paths only to avoid leaking token in logs/referer on all GET routes
  if (c.req.method === "GET" && c.req.path.endsWith("/stream")) {
    const queryToken = c.req.query("token");
    if (queryToken && queryToken === authConfig.token) {
      return next();
    }
  }

  // Fallback: short-lived download token for browser-initiated downloads only
  if (c.req.method === "GET") {
    const path = c.req.path;
    const isDownloadPath = path.endsWith("/files/raw") || path.endsWith("/files/download/zip");
    if (isDownloadPath) {
      const dlToken = c.req.query("dl_token");
      if (dlToken && consumeDownloadToken(dlToken)) {
        return next();
      }
    }
  }

  return c.json(err("Unauthorized"), 401);
}
