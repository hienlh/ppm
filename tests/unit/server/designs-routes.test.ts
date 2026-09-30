import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";

describe("design routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (path: string, init: RequestInit = {}, auth = true) => app.request(`http://localhost/api/project/demo/designs${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}), ...(init.headers ?? {}) },
  });
  const create = (title: string, kind = "page") => call("", { method: "POST", body: JSON.stringify({ title, kind }) });

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-routes-")));
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
    expect((await call("", {}, false)).status).toBe(401);
    expect((await call("", { method: "POST", body: "{}" }, false)).status).toBe(401);
  });

  it("creates, lists, reads, renames and deletes in the standard envelope", async () => {
    const created = await create("Landing");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ ok: true, data: { slug: "landing", title: "Landing", kind: "page" } });
    expect((await create("Landing")).status).toBe(201);

    const listed = await (await call("")).json();
    expect(listed.ok).toBe(true);
    expect(listed.data.designs.map((d: { slug: string }) => d.slug).sort()).toEqual(["landing", "landing-2"]);
    expect(listed.data.system).toEqual({ designMd: false, tokensCss: false });

    expect((await (await call("/landing")).json()).data.title).toBe("Landing");
    const renamed = await call("/landing", { method: "PATCH", body: JSON.stringify({ title: "Home" }) });
    expect((await renamed.json()).data).toMatchObject({ slug: "landing", title: "Home" });

    expect((await call("/landing", { method: "DELETE" })).status).toBe(400);
    expect((await call("/landing?confirm=landing-2", { method: "DELETE" })).status).toBe(400);
    expect(existsSync(join(project, "designs", "landing"))).toBe(true);
    const deleted = await call("/landing?confirm=landing", { method: "DELETE" });
    expect(await deleted.json()).toEqual({ ok: true, data: { deleted: "landing" } });
    expect(existsSync(join(project, "designs", "landing"))).toBe(false);
    expect((await call("/landing")).status).toBe(404);
  });

  it("rejects bad input with 400s", async () => {
    expect((await call("", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await call("", { method: "POST", body: "[]" })).status).toBe(400);
    expect((await create("")).status).toBe(400);
    expect((await create("x", "poster")).status).toBe(400);
    expect((await call("/Bad_Slug")).status).toBe(400);
    expect((await call("/..%2Fetc")).status).toBe(400);
  });

  it("lists history and restores, validating the snapshot id after decoding", async () => {
    await create("Home");
    const { snapshotDesign } = await import("../../../src/services/design/design-snapshots.service.ts");
    const first = await snapshotDesign(project, "home", "turn");
    const id = (first as { id: string }).id;
    writeFileSync(join(project, "designs", "home", "index.html"), "changed");

    const history = await (await call("/home/history")).json();
    expect(history.data.map((s: { id: string }) => s.id)).toEqual([id]);

    for (const bad of ["..%2F..%2Fx", "20260101-000000-abcd%2F..", "20260101-000000-ABCD", "x"]) {
      expect((await call(`/home/history/${bad}/restore`, { method: "POST" })).status).toBe(400);
    }
    expect((await call("/home/history/20260101-000000-abcd/restore", { method: "POST" })).status).toBe(404);

    const restored = await call(`/home/history/${id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.restored).toBe(id);
    expect(readFileSync(join(project, "designs", "home", "index.html"), "utf8")).not.toBe("changed");
    expect((await (await call("/home/history")).json()).data).toHaveLength(2);
  });

  it("reports the design system files", async () => {
    await create("Home");
    writeFileSync(join(project, "designs", "DESIGN.md"), "# x");
    writeFileSync(join(project, "designs", "tokens.css"), ":root{}");
    expect((await (await call("")).json()).data.system).toEqual({ designMd: true, tokensCss: true });
  });

  it("answers 404 for an unknown project", async () => {
    const res = await app.request("http://localhost/api/project/nope/designs", { headers: { Authorization: "Bearer design-test" } });
    expect(res.status).toBe(404);
  });
});
