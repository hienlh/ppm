/**
 * The share routes as the real server mounts them: after the access log, ahead of `cors()`,
 * `/api` authentication and the static fallback. Each assertion here fails if `/s` moves
 * behind one of them — the app shell answering a share path, `cors()` adding `*` or
 * re-wrapping a range body, or the access log writing a code.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../../src/server/index.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { createShareLink } from "../../../src/services/design/share/design-share-links.service.ts";
import { INVALID_PAGE_HTML } from "../../../src/services/design/share/design-share-guest-page.ts";
import { resetShareRateLimits } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { installFileLogSink, _resetLoggerForTests } from "../../../src/services/logger.ts";
import { STDIO_IS_LOG_ENV } from "../../../src/services/log-rotate.ts";

describe("design share routes in the server", () => {
  const previousAuth = structuredClone(configService.get("auth"));
  const previousProjects = [...configService.get("projects")];
  let project: string;
  let code: string;
  let logPath: string;
  let uninstall = () => {};

  beforeAll(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-share-mount-")));
    configService.set("auth", { ...previousAuth, enabled: true, token: "share-mount-token" });
    configService.set("projects", [{ name: "demo", path: project }]);
    await createDesign(project, { title: "Home", kind: "page" });
    writeFileSync(join(project, "designs", "home", "hero.png"), "0123456789");
    const link = await createShareLink(project, "home", { expiresAt: null, version: "current" });
    code = link.path!.slice(3);
    resetShareRateLimits();
    logPath = join(project, "ppm.log");
    _resetLoggerForTests();
    process.env[STDIO_IS_LOG_ENV] = "1";
    uninstall = installFileLogSink({ echo: "console", path: logPath });
  });

  afterAll(() => {
    uninstall();
    delete process.env[STDIO_IS_LOG_ENV];
    _resetLoggerForTests();
    resetShareRateLimits();
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("never falls through to the app shell", async () => {
    for (const path of ["/s", "/s/", `/s/${code}/`, `/s/${code}/x/y`, "/s/unknown"]) {
      const res = await app.request(path, { headers: { "Sec-Fetch-Dest": "document", Accept: "text/html" } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(INVALID_PAGE_HTML);
    }
  });

  it("is not behind cors(): no `*`, no preflight answer, and range bodies survive", async () => {
    const json = await app.request(`/s/${code}/comments`, { headers: { Origin: "https://evil.example" } });
    expect(json.status).toBe(200);
    expect(json.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request(`/s/${code}/comments`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-ppm-guest-key" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
    const part = await app.request(`/s/${code}/f/home/hero.png`, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("access-control-allow-origin")).toBe("null");
    expect(await part.text()).toBe("2345");
  });

  it("opens no authenticated route with a share code", async () => {
    expect((await app.request("/api/settings", { headers: { Authorization: `Bearer ${code}` } })).status).toBe(401);
    expect((await app.request(`/api/settings?token=${code}`)).status).toBe(401);
    expect((await app.request("/api/projects", { headers: { Authorization: `Bearer ${code}` } })).status).toBe(401);
    expect((await app.request(`/s/${code}/../../api/settings`)).status).toBe(401);
  });

  it("does not serve the built guest page outside /s", async () => {
    expect((await app.request("/design-share-page/index.html")).status).toBe(404);
  });

  it("writes a share request to the access log without its code", async () => {
    const res = await app.request(`/s/${code}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PPM-Request": "1", "X-PPM-Guest-Key": "k".repeat(43) },
      body: JSON.stringify({ body: "" }),
    });
    expect(res.status).toBe(400);
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(log).toContain("POST /s/[token]/comments 400");
    expect(log).not.toContain(code);
  });
});
