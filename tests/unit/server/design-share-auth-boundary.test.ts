/**
 * No authenticated PPM route is reachable with a design share code.
 *
 * Sending the code where the token goes and expecting 401 passes trivially if the routes
 * asked are not real (every unknown `/api` path is a 401 too) or if the probe cannot see a
 * leak. So the routes are the real app's own table, each one is shown to be reached through
 * the sign-in check, the real token is shown to pass that check in the same request shape,
 * and the probe is run against a deliberately leaky app to prove it reports leaks.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono, type Context, type Next } from "hono";
import { app } from "../../../src/server/index.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { resolveShareCode } from "../../../src/services/design/share/design-share-links.service.ts";
import { getLogLevel, setLogLevel } from "../../../src/services/logger.ts";
import { makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";
import { CARRIERS, concretePaths, probeShareCode, type ProbeRoute } from "./design-share-boundary-probe.ts";

const TOKEN = "share-guest-test";

/**
 * `/api` routes that answer without PPM sign-in, each on purpose. Adding a public route means
 * adding it here, deliberately; anything else under `/api` must sit behind the sign-in check.
 */
const PUBLIC_API_ROUTES = new Set([
  "GET /api/health",
  "GET /api/info",
  // Answers the authorization server's redirect, which carries no PPM token.
  "GET /api/mcp-auth/callback",
  // Per-session capability tokens of a chat's own subprocess.
  "ALL /api/design-mcp",
  "ALL /api/tab-tools-mcp",
  "ALL /api/db-tools-mcp",
]);
/** Preview content authenticates with its own bounded capability token in the path. */
const PUBLIC_API_PREFIXES = ["/api/html-preview/content/", "/api/design-preview/content/"];

type RouterRoute = (typeof app.routes)[number];
type MatchEntry = [[unknown, RouterRoute], unknown];

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const isPublic = (r: RouterRoute) => PUBLIC_API_ROUTES.has(keyOf(r)) || PUBLIC_API_PREFIXES.some((p) => r.path.startsWith(p));
/** `app.use()` entries: middleware, not a route anyone answers from. */
const isMiddleware = (r: RouterRoute) => r.handler === authMiddleware || (r.method === "ALL" && r.path.endsWith("*"));

/** The routes, in registration order, that the real router reaches for this method and path. */
function matched(method: string, path: string): RouterRoute[] {
  const result = app.router.match(method, path) as unknown as [MatchEntry[]];
  return result[0].map(([[, route]]) => route);
}

interface Enumerated { route: RouterRoute; probe: ProbeRoute; authFirst: boolean }

/** Every authenticated `/api` route of the real app, with a concrete path that reaches it. */
function enumerateAuthenticatedRoutes(): { routes: Enumerated[]; unreachable: string[] } {
  const seen = new Set<string>();
  const routes: Enumerated[] = [];
  const unreachable: string[] = [];
  for (const route of app.routes) {
    if (!route.path.startsWith("/api/") || isMiddleware(route) || isPublic(route) || seen.has(keyOf(route))) continue;
    seen.add(keyOf(route));
    const method = route.method === "ALL" ? "GET" : route.method;
    const path = concretePaths(route.path).find((p) => matched(method, p).includes(route));
    if (!path) { unreachable.push(keyOf(route)); continue; }
    const chain = matched(method, path);
    const auth = chain.findIndex((r) => r.handler === authMiddleware);
    routes.push({ route, probe: { method, path }, authFirst: auth !== -1 && auth < chain.indexOf(route) });
  }
  return { routes, unreachable };
}

describe("design share code against the real app's authenticated routes", () => {
  let fixture: ShareFixture;
  let level: ReturnType<typeof getLogLevel>;
  const { routes, unreachable } = enumerateAuthenticatedRoutes();

  beforeAll(async () => {
    fixture = await makeShareFixture();
    // Every refused probe is a WARN line in the access log; thousands of them are noise here.
    level = getLogLevel();
    setLogLevel("error");
  });
  afterAll(() => {
    setLogLevel(level);
    fixture.restore();
  });

  it("enumerates the real route table, every route reached and behind the sign-in check", () => {
    // A few hundred routes: a short list means the enumeration broke, not that PPM shrank.
    expect(routes.length).toBeGreaterThan(300);
    expect(unreachable).toEqual([]);
    expect(routes.filter((r) => !r.authFirst).map((r) => keyOf(r.route))).toEqual([]);
    for (const known of ["GET /api/projects", "GET /api/settings/ai", "PUT /api/fs/write", "GET /api/project/:projectName/designs"]) {
      expect(routes.map((r) => keyOf(r.route))).toContain(known);
    }
  });

  it("the code is a real one: it opens its shared design", async () => {
    expect((await resolveShareCode(fixture.code))?.link.id).toBe(fixture.link.id);
    expect((await app.request(`/s/${fixture.code}/info`)).status).toBe(200);
  });

  it("the real token passes the same sign-in check in the request shape the probe uses", async () => {
    // The real middleware in front of a stub, so no handler runs: the request reaches the stub
    // with the token and stops at 401 with the code, header for header.
    const check = new Hono();
    check.use("/api/*", authMiddleware);
    check.all("*", (c) => c.text("reached"));
    const bearer = CARRIERS.find((c) => c.name === "bearer header")!;
    for (const { probe } of routes) {
      const withToken = bearer.build(probe, TOKEN, "home");
      expect((await check.request(withToken.url, { method: probe.method, headers: withToken.headers })).status).toBe(200);
      const withCode = bearer.build(probe, fixture.code, "home");
      expect((await check.request(withCode.url, { method: probe.method, headers: withCode.headers })).status).toBe(401);
    }
  });

  it("probing the live app with the real token instead of the code does get through", async () => {
    // Routes that only read, so their handlers may run. The probe sees each one answered in
    // the carriers the sign-in check honours, which is what it would report for a code.
    const readOnly: ProbeRoute[] = ["/api/auth/check", "/api/projects", "/api/settings/ai", "/api/project/demo/designs",
      "/api/project/demo/designs/home/shares"].map((path) => ({ method: "GET", path }));
    const reached = await probeShareCode(app, readOnly, TOKEN, "home");
    for (const { path } of readOnly) {
      expect(reached).toContainEqual({ route: `GET ${path}`, carrier: "bearer header", status: 200 });
    }
    // The token is honoured in the Authorization header only on these routes.
    expect(new Set(reached.map((l) => l.carrier))).toEqual(new Set(["bearer header"]));
  });

  it("refuses the code in every carrier on every route", async () => {
    // Reads first, starting with the one that does nothing, so a leak is found by a request
    // whose handler changes nothing.
    const ordered = routes.map((r) => r.probe).sort((a, b) =>
      Number(b.path === "/api/auth/check") - Number(a.path === "/api/auth/check") || Number(b.method === "GET") - Number(a.method === "GET"));
    const leaks = await probeShareCode(app, ordered, fixture.code, "home", { stopAtFirstLeak: true });
    expect(leaks).toEqual([]);
  }, 120_000);
});

describe("the probe notices a leak", () => {
  let fixture: ShareFixture;
  beforeAll(async () => { fixture = await makeShareFixture(); });
  afterAll(() => fixture.restore());

  /** Accepts a valid share code from any carrier as if it were the token, which is the bug. */
  async function leakyAuth(c: Context, next: Next) {
    const fromHeader = c.req.header("Authorization")?.replace(/^Bearer /, "");
    const fromCookie = /(?:^|;\s*)ppm_token=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
    for (const candidate of [fromHeader, fromCookie, c.req.query("token")]) {
      if (candidate && await resolveShareCode(candidate)) return next();
    }
    return authMiddleware(c, next);
  }

  const routes: ProbeRoute[] = [
    { method: "GET", path: "/api/projects" },
    { method: "PUT", path: "/api/fs/write" },
    { method: "DELETE", path: "/api/project/demo/designs/home" },
  ];
  /** The real app's shape: the sign-in check on `/api/*`, a share sub-app with its own catch-all. */
  function appWith(auth: typeof authMiddleware, pathLeak: boolean): Hono {
    const target = new Hono();
    if (pathLeak) {
      // A share route that forwards whatever follows the code to the API, signed in.
      target.all("/s/:code/*", async (c) => {
        if (!(await resolveShareCode(c.req.param("code")))) return c.text("invalid", 404);
        return c.json({ ok: true, data: "the API's answer" });
      });
    }
    target.all("/s/*", (c) => c.text("invalid", 404));
    target.use("/api/*", auth);
    for (const r of routes) target.on(r.method, r.path, (c) => c.json({ ok: true }));
    return target;
  }

  it("reports every carrier a leaky sign-in check accepts, on every route", async () => {
    const leaks = await probeShareCode(appWith(leakyAuth, true), routes, fixture.code, "home");
    const carriers = new Set(leaks.map((l) => l.carrier));
    for (const name of ["bearer header", "raw authorization header", "cookie", "query", "path prefix", "dot segments from a design file"]) {
      expect(carriers).toContain(name);
    }
    for (const r of routes) expect(leaks.some((l) => l.route === `${r.method} ${r.path}`)).toBe(true);
  });

  it("reports nothing for the same app with the real sign-in check, so the leaks above are the bug", async () => {
    expect(await probeShareCode(appWith(authMiddleware, false), routes, fixture.code, "home")).toEqual([]);
  });

  it("does not take a 401 from a wrong code as proof: an unknown code leaks nothing even through the leaky check", async () => {
    const unknown = `${fixture.code.slice(0, -1)}${fixture.code.endsWith("A") ? "B" : "A"}`;
    expect(await probeShareCode(appWith(leakyAuth, true), routes, unknown, "home")).toEqual([]);
  });
});
