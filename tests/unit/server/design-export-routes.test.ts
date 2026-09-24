import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzip } from "unzipit";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";

describe("design export routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  const get = (path: string, auth = true) => app.request(`http://localhost/api/project/demo/designs/${path}`, {
    headers: auth ? { Authorization: "Bearer export-test" } : {},
  });

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-export-routes-")));
    await createDesign(project, { title: "Home", kind: "page" });
    const dir = join(project, "designs", "home");
    writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../tokens.css"></head><body><img src="logo.png"><img src="gone.png"></body></html>');
    writeFileSync(join(dir, "logo.png"), "PNG");
    mkdirSync(join(dir, "pages"));
    writeFileSync(join(dir, "pages", "about.html"), "<p>About</p>");
    writeFileSync(join(project, "designs", "tokens.css"), ":root{--a:1}");
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/project/:projectName", projectScopedRouter);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "export-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("requires auth", async () => {
    expect((await get("home/export/zip", false)).status).toBe(401);
    expect((await get("home/export/html", false)).status).toBe(401);
  });

  it("streams the zip as an octet-stream attachment", async () => {
    const res = await get("home/export/zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="home.zip"');
    const { entries } = await unzip(await res.arrayBuffer());
    expect(Object.keys(entries)).toContain("tokens.css");
    expect(Object.keys(entries)).toContain("home/index.html");
    expect(Object.keys(entries).some((n) => n.includes(".design"))).toBe(false);
  });

  it("answers the standalone page as octet-stream with the warnings counted and listed", async () => {
    const res = await get("home/export/html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="home.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-ppm-export-warnings")).toBe("1");
    expect(JSON.parse(decodeURIComponent(res.headers.get("x-ppm-export-warning-list")!))).toEqual(["gone.png: not found, left linked"]);
    const html = await res.text();
    expect(html).toContain("<style>:root{--a:1}</style>");
    expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from("PNG").toString("base64")}">`);
  });

  it("keeps the warning list header small however many warnings there are", async () => {
    const imgs = Array.from({ length: 300 }, (_, i) => `<img src="missing-${i}-${"x".repeat(40)}.png">`).join("");
    writeFileSync(join(project, "designs", "home", "index.html"), `<meta charset="utf-8">${imgs}`);
    const res = await get("home/export/html");
    expect(res.headers.get("x-ppm-export-warnings")).toBe("300");
    const header = res.headers.get("x-ppm-export-warning-list")!;
    expect(header.length).toBeLessThanOrEqual(3000);
    const listed = JSON.parse(decodeURIComponent(header)) as string[];
    expect(listed.length).toBeGreaterThan(5);
    expect(listed[0]).toStartWith("missing-0-");
  });

  it("exports another page by ?entry= and names the file after it", async () => {
    const res = await get("home/export/html?entry=pages%2Fabout.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="home-about.html"');
  });

  it("refuses an entry outside the design, in a dot-dir or encoded twice, and a missing page", async () => {
    for (const entry of ["..%2Fother.html", "%252e%252e%2Fx.html", ".design%2Fx.html", "..%5Cx.html", "%2Fetc%2Fx.html", "styles.css"]) {
      expect((await get(`home/export/html?entry=${entry}`)).status).toBe(400);
    }
    expect((await get("home/export/html?entry=nope.html")).status).toBe(404);
    expect((await get("missing/export/html")).status).toBe(404);
    expect((await get("missing/export/zip")).status).toBe(404);
  });
});
