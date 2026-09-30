import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";

describe("design systems routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (path: string, init: RequestInit = {}) => app.request(`http://localhost/api/project/demo/designs/systems${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: "Bearer design-test", ...(init.headers ?? {}) },
  });
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data?: unknown; error?: string };

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-systems-routes-")));
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/project/:projectName", projectScopedRouter);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "design-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    const res = await app.request("http://localhost/api/project/demo/designs/systems");
    expect(res.status).toBe(401);
  });

  it("lists the implicit default app, then declares, edits and removes a real one", async () => {
    const list0 = await json(await call(""));
    expect(list0.data).toEqual([{
      id: "default", label: "Default", root: ".", platform: "web", declared: false, hasDesignMd: false, hasTokensCss: false,
    }]);

    const created = await call("", { method: "POST", body: JSON.stringify({ label: "Payroll", root: "payroll-fe", platform: "web" }) });
    expect(created.status).toBe(201);
    const app1 = (await json(created)).data as { id: string };
    expect(app1.id).toBe("payroll");

    const patched = await call(`/${app1.id}`, { method: "PATCH", body: JSON.stringify({ label: "Payroll FE", platform: "mobile" }) });
    expect((await json(patched)).data).toMatchObject({ label: "Payroll FE", platform: "mobile", root: "payroll-fe" });

    // Removing needs ?confirm=<id>, same rule as an ordinary design.
    expect((await call(`/${app1.id}`, { method: "DELETE" })).status).toBe(400);
    const removed = await call(`/${app1.id}?confirm=${app1.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await json(await call(""))).data).toEqual([{
      id: "default", label: "Default", root: ".", platform: "web", declared: false, hasDesignMd: false, hasTokensCss: false,
    }]);
  });

  it("refuses to remove the default app", async () => {
    const res = await call("/default?confirm=default", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("get-or-creates an app's showcase design at system-<id>, idempotently", async () => {
    await call("", { method: "POST", body: JSON.stringify({ label: "Payroll", root: "payroll-fe", platform: "web" }) });
    const first = await json(await call("/payroll/showcase", { method: "POST" }));
    expect(first.data).toMatchObject({ slug: "system-payroll", showcaseFor: "payroll" });
    expect(existsSync(join(project, "designs", "system-payroll", "index.html"))).toBe(true);
    const second = await json(await call("/payroll/showcase", { method: "POST" }));
    expect(second.data).toMatchObject({ slug: "system-payroll" });
  });

  it("remembers a skipped setup through the route", async () => {
    await call("", { method: "POST", body: JSON.stringify({ label: "Payroll", root: "payroll-fe", platform: "web" }) });
    expect((await call("/payroll/skip-setup", { method: "POST" })).status).toBe(200);
    const system = (await json(await call("/payroll"))).data as { setupSkipped?: boolean };
    expect(system.setupSkipped).toBe(true);
  });

  it("answers unknown with no builtFrom recorded yet", async () => {
    await call("", { method: "POST", body: JSON.stringify({ label: "Payroll", root: "payroll-fe", platform: "web" }) });
    const stale = (await json(await call("/payroll/stale"))).data;
    expect(stale).toEqual({ stale: false, unknown: true });
  });

  it("404s an unknown app and rejects a bad label or platform", async () => {
    expect((await call("/ghost")).status).toBe(404);
    expect((await call("", { method: "POST", body: JSON.stringify({ label: "", root: ".", platform: "web" }) })).status).toBe(400);
    expect((await call("", { method: "POST", body: JSON.stringify({ label: "X", root: ".", platform: "desktop" }) })).status).toBe(400);
  });
});
