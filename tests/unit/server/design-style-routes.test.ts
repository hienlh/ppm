import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { designWriteClock, resetDesignWriteLimits } from "../../../src/services/design/design-write-rate-limit.ts";
import { resetDesignUndoJournals } from "../../../src/services/design/design-edit-undo-journal.ts";

const PAGE = "<!doctype html><html><head></head><body><div class=\"box\">Box</div>"
  + "<p>A paragraph that keeps other edits well away from the box.</p><footer>Foot</footer></body></html>";
const BOX = PAGE.indexOf("<div");

describe("design style and undo routes", () => {
  let project: string;
  let app: Hono;
  let now = 0;
  const realNow = designWriteClock.now;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const post = (path: string, body: unknown, auth = true) => app.request(`http://localhost/api/project/demo/designs/home/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const html = () => readFileSync(join(project, "designs", "home", "index.html"), "utf8");
  const style = (over: Record<string, unknown> = {}) =>
    post("style", { file: "index.html", gen: computeGen(html()), ppmId: BOX, tag: "div", props: { translate: "8px 4px" }, ...over });

  beforeEach(async () => {
    resetDesignWriteLimits();
    resetDesignUndoJournals();
    now = 1_000_000;
    designWriteClock.now = () => (now += 1000);
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-style-routes-")));
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
    designWriteClock.now = realNow;
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    expect((await post("style", {}, false)).status).toBe(401);
    expect((await post("undo", {}, false)).status).toBe(401);
  });

  it("writes the style and answers {gen, undoId}; undo reverts it", async () => {
    const res = await style();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(html()).toBe(PAGE.replace('<div class="box">', '<div style="translate: 8px 4px" class="box">'));
    expect(data).toEqual({ gen: computeGen(html()), undoId: expect.stringMatching(/^[0-9a-f]{16}$/) });

    const undone = await post("undo", { undoId: data.undoId });
    expect(undone.status).toBe(200);
    expect(html()).toBe(PAGE);
    expect((await undone.json()).data).toEqual({ gen: computeGen(PAGE), gens: { "index.html": computeGen(PAGE) } });
  });

  it("answers 409 stale and element-moved with the reason and current gen", async () => {
    const stale = await style({ gen: "0123456789abcdef" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, data: { reason: "stale", currentGen: computeGen(PAGE) } });
    const moved = await style({ tag: "section" });
    expect(moved.status).toBe(409);
    expect((await moved.json()).data).toMatchObject({ reason: "element-moved" });
    expect(html()).toBe(PAGE);
  });

  it("answers 400 for a bad body or props outside the allowlist", async () => {
    expect((await post("style", "[]")).status).toBe(400);
    expect((await style({ props: { color: "red" } })).status).toBe(400);
    expect((await style({ props: { width: "calc(1px)" } })).status).toBe(400);
    expect(html()).toBe(PAGE);
  });

  it("answers 429 over the write limit", async () => {
    designWriteClock.now = () => now;
    expect((await style()).status).toBe(200);
    const res = await style({ props: { translate: "1px 1px" } });
    expect(res.status).toBe(429);
  });

  it("answers undo with 404 for an unknown id and 409 cannot-undo once the text changed", async () => {
    expect((await post("undo", { undoId: "0123456789abcdef" })).status).toBe(404);
    expect((await post("undo", { undoId: "nope" })).status).toBe(404);
    const { data } = await (await style()).json();
    writeFileSync(join(project, "designs", "home", "index.html"), html().replace("translate: 8px 4px", "translate: 99px 4px"));
    const res = await post("undo", { undoId: data.undoId });
    expect(res.status).toBe(409);
    expect((await res.json()).data).toEqual({ reason: "cannot-undo" });
  });
});
