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

const PAGE = "<!doctype html><html><head><style>:root { --accent: #111111; }</style></head><body></body></html>";

describe("design tweak routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (init: RequestInit = {}, auth = true) => app.request("http://localhost/api/project/demo/designs/home/tweaks", {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}) },
  });
  const post = (body: unknown) => call({ method: "POST", body: JSON.stringify(body) });
  const html = () => readFileSync(join(project, "designs", "home", "index.html"), "utf8");

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-tweak-routes-")));
    await createDesign(project, { title: "Home", kind: "page" });
    const dir = join(project, "designs", "home");
    writeFileSync(join(dir, "index.html"), PAGE);
    const manifest = JSON.parse(readFileSync(join(dir, "design.json"), "utf8"));
    writeFileSync(join(dir, "design.json"), JSON.stringify({
      ...manifest, tweaks: [{ id: "accent", label: "Accent", type: "color", var: "--accent", default: "#000000" }],
    }));
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
    expect((await call({}, false)).status).toBe(401);
    expect((await call({ method: "POST", body: "{}" }, false)).status).toBe(401);
  });

  it("lists the declared tweaks", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ manifestValid: true, errors: [], tweaks: [{ id: "accent", var: "--accent" }] });
  });

  it("applies a value and answers with the new gens", async () => {
    const res = await post({ entry: "index.html", gens: { "index.html": computeGen(PAGE) }, values: { "--accent": "#6366f1" } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(html()).toBe(PAGE.replace("#111111", "#6366f1"));
    expect(data).toEqual({ gens: { "index.html": computeGen(html()) } });
  });

  it("answers a stale gen with 409 naming the file and its current gen", async () => {
    const res = await post({ entry: "index.html", gens: { "index.html": "0123456789abcdef" }, values: { "--accent": "#6366f1" } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, data: { file: "index.html", currentGen: computeGen(PAGE) } });
    expect(html()).toBe(PAGE);
  });

  it("answers 400 for a bad body or an undeclared variable", async () => {
    expect((await call({ method: "POST", body: "[]" })).status).toBe(400);
    expect((await post({ entry: "index.html", gens: {}, values: { "--nope": "#fff" } })).status).toBe(400);
    expect((await post({ entry: "index.html", gens: {}, values: { "--accent": "red;}x{" } })).status).toBe(400);
    expect(html()).toBe(PAGE);
  });
});
