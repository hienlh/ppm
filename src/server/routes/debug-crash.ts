import type { Hono } from "hono";

/**
 * `GET /api/debug/crash` exits the server, for watching the supervisor's health check and
 * restart UI react to a dead child. It is never on by default: being a development server is
 * not a reason, because a dev server is routinely reachable through a tunnel, and anyone who
 * can reach a route that exits the process can take PPM down at will.
 *
 * `PPM_DEBUG_CRASH_ROUTE=1` (or `true`) opts in, and the caller mounts it after the sign-in
 * check, so even then only a signed-in user reaches it.
 */
export function isDebugCrashRouteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.PPM_DEBUG_CRASH_ROUTE?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Registers the route on `app` when opted in. `app` must already require sign-in on `/api/*`. */
export function mountDebugCrashRoute(
  app: Hono,
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = (code) => process.exit(code),
): boolean {
  if (!isDebugCrashRouteEnabled(env)) return false;
  app.get("/api/debug/crash", (c) => {
    // Answer first so the caller sees the request was taken, then exit on the next tick.
    setTimeout(() => exit(1), 0);
    return c.text("exiting", 202);
  });
  return true;
}
