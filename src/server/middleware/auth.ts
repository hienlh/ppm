import type { Context, Next } from "hono";
import { configService } from "../../services/config.service.ts";
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
  if (!header || !header.startsWith("Bearer ")) {
    return c.json(err("Unauthorized"), 401);
  }

  const token = header.slice(7);
  if (token !== authConfig.token) {
    return c.json(err("Unauthorized"), 401);
  }

  return next();
}
