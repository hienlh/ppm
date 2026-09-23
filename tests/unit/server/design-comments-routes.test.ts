import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";

const PAGE = "<!doctype html><html><body><main><h1>Welcome</h1><p>Pricing starts at $9 a month</p></main></body></html>";

describe("design comment routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (path: string, init: RequestInit = {}, auth = true) => app.request(`http://localhost/api/project/demo/designs/home/comments${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}), ...(init.headers ?? {}) },
  });
  const anchor = () => ({
    file: "index.html", ppmId: PAGE.indexOf("<p>"), gen: computeGen(PAGE), tag: "p", cssPath: "body > main:nth-of-type(1) > p:nth-of-type(1)",
    quote: { exact: "Pricing starts at $9 a month", prefix: "Welcome", suffix: "" },
  });
  const post = (body: unknown, path = "") => call(path, { method: "POST", body: JSON.stringify(body) });

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-comment-routes-")));
    await createDesign(project, { title: "Home", kind: "page" });
    writeFileSync(join(project, "designs", "home", "index.html"), PAGE);
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

  it("creates, lists, updates and deletes in the standard envelope", async () => {
    const created = await post({ anchor: anchor(), body: "Bolder" });
    expect(created.status).toBe(201);
    const { data: comment } = await created.json();
    expect(comment).toMatchObject({ body: "Bolder", file: "index.html", snippet: "<p>Pricing starts at $9 a month</p>" });

    const listed = await (await call("")).json();
    expect(listed).toMatchObject({ ok: true, data: [{ id: comment.id }] });

    const patched = await call(`/${comment.id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
    expect((await patched.json()).data.resolvedAt).toBeTruthy();

    expect((await call(`/${comment.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await (await call("")).json()).data).toEqual([]);
    expect((await call(`/${comment.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers the server-built context for one element without saving", async () => {
    const res = await post({ anchor: anchor() }, "/context");
    expect(await res.json()).toEqual({
      ok: true,
      data: { snippet: "<p>Pricing starts at $9 a month</p>", quote: { exact: "Pricing starts at $9 a month", prefix: "Welcome", suffix: "" } },
    });
    expect((await (await call("")).json()).data).toEqual([]);
  });

  it("rejects bad input and unknown targets", async () => {
    expect((await call("", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await post({ anchor: { ...anchor(), file: "../x.html" }, body: "x" })).status).toBe(400);
    expect((await call("/abcdefabcdef", { method: "PATCH", body: JSON.stringify({ resolved: true }) })).status).toBe(404);
    const other = await app.request("http://localhost/api/project/demo/designs/nope/comments", { headers: { Authorization: "Bearer design-test" } });
    expect(other.status).toBe(404);
  });

  it("answers 409 to a re-anchor the source does not support", async () => {
    const { data: comment } = await (await post({ anchor: anchor(), body: "x" })).json();
    const res = await call(`/${comment.id}`, { method: "PATCH", body: JSON.stringify({ anchor: { ppmId: PAGE.indexOf("<h1>"), gen: computeGen(PAGE) } }) });
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBe(false);
  });
});
