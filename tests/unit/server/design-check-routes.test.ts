import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { onDesignEvent } from "../../../src/services/design/design-events.ts";
import { canvasCheckBroker } from "../../../src/services/design/check/design-canvas-check-broker.ts";

const REPORT = {
  viewport: { width: 1280, height: 800 }, page: { width: 1280, height: 800 },
  findings: [{ kind: "implicit-grid", message: "pushed", element: "div.workspace" }], counts: { "implicit-grid": 1 },
  file: "index.html", gen: null, frame: "Desktop",
};

describe("design check result route", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  const post = (slug: string, id: string, body: unknown, auth = true) => app.request(`http://localhost/api/project/demo/designs/${slug}/check/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  /** Starts a real broker request and hands back its id, as a browser would see it. */
  const pending = (slug = "home") => {
    let requestId = "";
    const off = onDesignEvent((type, payload) => { if (type === "check_request") requestId = payload.requestId ?? ""; });
    const outcome = canvasCheckBroker.request(project, slug, { screenshot: false });
    off();
    return { requestId, outcome };
  };

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-check-routes-")));
    await createDesign(project, { title: "Home", kind: "page" });
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

  it("settles the pending check with the posted report", async () => {
    const { requestId, outcome } = pending();
    expect((await post("home", requestId, REPORT, false)).status).toBe(401);
    const res = await post("home", requestId, REPORT);
    expect(res.status).toBe(200);
    const settled = await outcome;
    expect(settled.ok && settled.report.findings[0]!.message).toBe("pushed");
    expect((await post("home", requestId, REPORT)).status).toBe(404);
  });

  it("refuses another design's id, a malformed report and an oversized body", async () => {
    const { requestId, outcome } = pending();
    expect((await post("other", requestId, REPORT)).status).toBe(404);
    expect((await post("home", requestId, { findings: "nope" })).status).toBe(400);
    expect((await post("home", requestId, "{")).status).toBe(400);
    expect((await post("home", "bad!", REPORT)).status).toBe(400);
    expect((await post("home", requestId, { ...REPORT, pad: "x".repeat(800 * 1024) })).status).toBe(413);
    // Still pending for the right answer.
    expect((await post("home", requestId, REPORT)).status).toBe(200);
    expect((await outcome).ok).toBe(true);
  });
});
