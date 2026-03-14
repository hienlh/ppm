import type { Context, Next } from "hono";
import type { PpmConfig } from "../../types/config.ts";

export function createAuthMiddleware(config: PpmConfig) {
  return async (c: Context, next: Next) => {
    if (!config.auth.enabled) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }

    const token = authHeader.slice(7);
    if (token !== config.auth.token) {
      return c.json({ ok: false, error: "Invalid token" }, 401);
    }

    return next();
  };
}
