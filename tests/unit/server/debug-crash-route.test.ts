import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { app } from "../../../src/server/index.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { isDebugCrashRouteEnabled, mountDebugCrashRoute } from "../../../src/server/routes/debug-crash.ts";
import { configService } from "../../../src/services/config.service.ts";

const TOKEN = "debug-crash-test-token";
const savedAuth = { ...configService.get("auth") };

/** The real app's order: the sign-in check on `/api/*`, then the route. */
function appWith(env: Record<string, string | undefined>, exits: number[]): Hono {
  const target = new Hono();
  target.use("/api/*", authMiddleware);
  mountDebugCrashRoute(target, env, (code) => exits.push(code));
  return target;
}

const signedIn = { headers: { Authorization: `Bearer ${TOKEN}` } };
const nextTick = () => new Promise((r) => setTimeout(r, 5));

describe("debug crash route", () => {
  afterEach(() => configService.set("auth", savedAuth));
  const withAuth = () => configService.set("auth", { ...savedAuth, enabled: true, token: TOKEN });

  it("is off unless explicitly opted in, whatever NODE_ENV says", () => {
    expect(isDebugCrashRouteEnabled({})).toBe(false);
    expect(isDebugCrashRouteEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isDebugCrashRouteEnabled({ PPM_DEBUG_CRASH_ROUTE: "0" })).toBe(false);
    expect(isDebugCrashRouteEnabled({ PPM_DEBUG_CRASH_ROUTE: "yes" })).toBe(false);
    expect(isDebugCrashRouteEnabled({ PPM_DEBUG_CRASH_ROUTE: "1" })).toBe(true);
    expect(isDebugCrashRouteEnabled({ PPM_DEBUG_CRASH_ROUTE: " TRUE " })).toBe(true);
  });

  it("is not registered on the real app without the opt-in", async () => {
    expect(process.env.PPM_DEBUG_CRASH_ROUTE).toBeUndefined();
    expect(app.routes.some((r) => r.path === "/api/debug/crash")).toBe(false);
    withAuth();
    // Signed in, so a 401 cannot stand in for "absent".
    const res = await app.request("/api/debug/crash", signedIn);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(202);
  });

  it("without the opt-in, a signed-in request does not exit", async () => {
    withAuth();
    const exits: number[] = [];
    const res = await appWith({ NODE_ENV: "development" }, exits).request("/api/debug/crash", signedIn);
    await nextTick();
    expect(res.status).toBe(404);
    expect(exits).toEqual([]);
  });

  it("when opted in, an unauthenticated request is refused with 401 and does not exit", async () => {
    withAuth();
    const exits: number[] = [];
    const target = appWith({ PPM_DEBUG_CRASH_ROUTE: "1" }, exits);
    expect((await target.request("/api/debug/crash")).status).toBe(401);
    expect((await target.request("/api/debug/crash", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    await nextTick();
    expect(exits).toEqual([]);
  });

  it("when opted in, a signed-in request exits with code 1", async () => {
    withAuth();
    const exits: number[] = [];
    const res = await appWith({ PPM_DEBUG_CRASH_ROUTE: "1" }, exits).request("/api/debug/crash", signedIn);
    expect(res.status).toBe(202);
    await nextTick();
    expect(exits).toEqual([1]);
  });
});
