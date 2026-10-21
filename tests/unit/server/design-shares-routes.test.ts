import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { designShareAddressRoutes } from "../../../src/server/routes/design-share-address.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { resolveShareCode } from "../../../src/services/design/share/design-share-links.service.ts";
import { SHARE_LIMITS } from "../../../src/shared/design-share-types.ts";
import { addComment, listComments } from "../../../src/services/design/design-comments.service.ts";

describe("design share routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (path: string, init: RequestInit = {}, auth = true) => app.request(`http://localhost${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer share-test" } : {}), ...(init.headers ?? {}) },
  });
  const shares = (path = "", init: RequestInit = {}, auth = true) => call(`/api/project/demo/designs/home/shares${path}`, init, auth);
  const create = (body: Record<string, unknown> = {}) => shares("", {
    method: "POST", body: JSON.stringify({ expiresAt: null, version: "current", ...body }),
  });

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-shares-routes-")));
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/design-shares", designShareAddressRoutes);
    app.route("/api/project/:projectName", projectScopedRouter);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "share-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
    getDb().exec("DELETE FROM design_share_links");
    const made = await call("/api/project/demo/designs", { method: "POST", body: JSON.stringify({ title: "Home" }) });
    expect(made.status).toBe(201);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    expect((await shares("", {}, false)).status).toBe(401);
    expect((await shares("", { method: "POST", body: "{}" }, false)).status).toBe(401);
    expect((await call("/api/design-shares/address", {}, false)).status).toBe(401);
  });

  it("creates, lists, updates and deletes, never sending the hash", async () => {
    const created = await create({ label: "Client" });
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data.link).toMatchObject({ label: "Client", status: "active", expiresAt: null });
    expect(data.link.path).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(data)).not.toMatch(/hash/i);

    const listed = await (await shares()).json();
    expect(listed.data.links.map((l: { id: string }) => l.id)).toEqual([data.link.id]);
    expect(listed.data.links[0].path).toBe(data.link.path);

    const renamed = await shares(`/${data.link.id}`, { method: "PATCH", body: JSON.stringify({ label: "Renamed" }) });
    expect((await renamed.json()).data.link.label).toBe("Renamed");

    const repinned = await (await shares(`/${data.link.id}`, { method: "PATCH", body: JSON.stringify({ repin: true }) })).json();
    expect(repinned.data.changedFiles).toEqual({ added: [], removed: [], changed: [], truncated: false });

    const revoked = await (await shares(`/${data.link.id}`, { method: "PATCH", body: JSON.stringify({ revoke: true }) })).json();
    expect(revoked.data.link).toMatchObject({ status: "revoked", path: null });
    const refused = await shares(`/${data.link.id}`, { method: "PATCH", body: JSON.stringify({ newCode: true }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: "revoked" });

    const deleted = await shares(`/${data.link.id}`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ ok: true, data: { deleted: data.link.id } });
    expect((await shares(`/${data.link.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers bad input with 400 and an unknown design with 404", async () => {
    expect((await shares("", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await create({ expiresAt: Date.now() - 1 })).status).toBe(400);
    expect((await create({ version: "nope" })).status).toBe(400);
    const missing = await call("/api/project/demo/designs/ghost/shares", {
      method: "POST", body: JSON.stringify({ expiresAt: null, version: "current" }),
    });
    expect(missing.status).toBe(404);
    expect((await call("/api/project/demo/designs/Bad_Slug/shares")).status).toBe(400);
    expect((await shares("/abcdef012345", { method: "PATCH", body: JSON.stringify({ label: "x" }) })).status).toBe(404);
  });

  it("refuses the link past the limit with 409 limit", async () => {
    for (let i = 0; i < SHARE_LIMITS.maxLinksPerDesign; i++) expect((await create({ label: `#${i}` })).status).toBe(201);
    const over = await create();
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ ok: false, code: "limit" });
  });

  it("refuses to share while sign-in is off, and its links stop opening", async () => {
    const { data } = await (await create()).json();
    configService.set("auth", { ...configService.get("auth"), enabled: false });
    const refused = await create();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: "signin-off" });
    expect(await resolveShareCode(data.link.path.slice(3))).toBeNull();
    const address = await (await call("/api/design-shares/address")).json();
    expect(address.data).toMatchObject({ authEnabled: false });
    expect(["named", "quick", "none"]).toContain(address.data.kind);
  });

  it("previews a re-pin's changed files, only for this design's own links", async () => {
    const link = (await (await create()).json()).data.link;
    writeFileSync(join(project, "designs", "home", "extra.css"), "a{}");
    const preview = await shares(`/${link.id}/changes`);
    expect(preview.status).toBe(200);
    expect((await preview.json()).data).toEqual({ changedFiles: { added: ["extra.css"], removed: [], changed: [], truncated: false } });
    expect((await shares(`/${link.id}/changes`, {}, false)).status).toBe(401);

    expect((await call("/api/project/demo/designs", { method: "POST", body: JSON.stringify({ title: "Other" }) })).status).toBe(201);
    const other = await call(`/api/project/demo/designs/other/shares/${link.id}/changes`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ ok: false, code: "not-found" });
    expect((await shares("/abcdef012345/changes")).status).toBe(404);
  });

  it("bulk-deletes one link's comment threads, also after the link itself is gone", async () => {
    writeFileSync(join(project, "designs", "home", "index.html"), "<p>Hello</p>");
    const one = (await (await create({ label: "One" })).json()).data.link;
    const two = (await (await create({ label: "Two" })).json()).data.link;
    const anchor = { file: "index.html", ppmId: null, gen: null, tag: "p", cssPath: "", quote: { exact: "Hello", prefix: "", suffix: "" } };
    const say = (linkId: string, snapshotId: string) => addComment(project, "home", { anchor, body: "Hi" }, {
      actor: { kind: "guest", name: "Ann", linkId, keyHash: "f".repeat(64) }, source: { snapshotId },
    });
    await say(one.id, one.snapshotId);
    await say(one.id, one.snapshotId);
    await say(two.id, two.snapshotId);
    await addComment(project, "home", { anchor, body: "Owner note" });

    const res = await shares(`/${one.id}/comments`, { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, data: { deleted: 2 } });
    expect((await listComments(project, "home")).map((c) => c.body)).toEqual(["Hi", "Owner note"]);

    expect((await shares(`/${two.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await (await shares(`/${two.id}/comments`, { method: "DELETE" })).json()).data).toEqual({ deleted: 1 });
    expect((await shares("/not-a-link/comments", { method: "DELETE" })).status).toBe(404);
    expect((await shares(`/${one.id}/comments`, { method: "DELETE" }, false)).status).toBe(401);
  });
});
