import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHtmlPreviewRoutes } from "../../../src/server/routes/html-preview.ts";
import { configService } from "../../../src/services/config.service.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";

describe("HTML preview capabilities", () => {
  let root: string;
  let app: Hono;
  let time: number;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  const request = (path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init);
  const create = (filePath: string, projectName?: string) => request("/api/html-preview", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer preview-test" },
    body: JSON.stringify({ filePath, projectName }),
  });
  const createUrl = async () => {
    const response = await create(join(root, "site", "index.html"));
    expect(response.status).toBe(200);
    return (await response.json()).data.url as string;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ppm-html-preview-"));
    mkdirSync(join(root, "site", "nested"), { recursive: true });
    writeFileSync(join(root, "site", "index.html"), '<html><img src="nested/a.png"><script src="app.js"></script></html>');
    writeFileSync(join(root, "site", "nested", "a.png"), "image");
    writeFileSync(join(root, "site", "app.js"), "window.preview = true;");
    writeFileSync(join(root, "site", "clip.mp4"), "0123456789");
    time = 1000;
    const routes = createHtmlPreviewRoutes(() => time);
    app = new Hono();
    app.route("/api/html-preview/content", routes.content);
    app.use("/api/*", authMiddleware);
    app.route("/api/html-preview", routes.api);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "preview-test" });
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(root, { recursive: true, force: true });
  });

  it("requires session authentication to create a preview", async () => {
    expect((await request("/api/html-preview", { method: "POST", body: "{}" })).status).toBe(401);
  });
  it("resolves registered project paths and rejects lexical and symlink escapes", async () => {
    configService.set("projects", [{ name: "preview-project", path: join(root, "site") }]);
    const created = await create("index.html", "preview-project");
    expect(created.status).toBe(200);
    expect((await request((await created.json()).data.url)).status).toBe(200);
    writeFileSync(join(root, "outside.html"), "<p>outside project</p>");
    symlinkSync(root, join(root, "site", "escape"), process.platform === "win32" ? "junction" : "dir");
    expect((await create("../outside.html", "preview-project")).status).toBe(403);
    expect((await create("escape/outside.html", "preview-project")).status).toBe(403);
    expect((await create("index.html", "unknown-project")).status).toBe(400);
    expect((await create("index.html")).status).toBe(400);
  });
  it("rejects malformed creation bodies", async () => {
    for (const body of ["{", "null", "[]", "{}", '{"filePath":42}', '{"filePath":"index.html","projectName":42}']) {
      const response = await request("/api/html-preview", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer preview-test" }, body,
      });
      expect(response.status).toBe(400);
    }
  });
  it("does not authorize writes and returns 404 for missing assets", async () => {
    const url = await createUrl();
    expect((await request(`${dirname(url)}/missing.png`)).status).toBe(404);
    expect((await request(url, { method: "PUT", body: "overwrite" })).status).toBe(401);
    expect((await request(url, {
      method: "PUT", headers: { Authorization: "Bearer preview-test" }, body: "overwrite",
    })).status).toBe(404);
    expect(await (await request(url)).text()).toContain("nested/a.png");
  });
  it("serves HTML and nested assets without disclosing session credentials", async () => {
    const url = await createUrl();
    expect(url).not.toContain("preview-test");
    const response = await request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("nested/a.png");
    expect(await (await request(`${dirname(url)}/nested/a.png`)).text()).toBe("image");
    expect(await (await request(`${dirname(url)}/app.js`)).text()).toContain("window.preview");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain(`connect-src localhost${dirname(url)}/`);
    expect(csp).toContain("form-action 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("supports video byte ranges", async () => {
    const url = await createUrl();
    const response = await request(`${dirname(url)}/clip.mp4`, { headers: { Range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });
  it("uses the browser Host for CSP and rejects directive-injection characters", async () => {
    const url = await createUrl();
    const response = await request(url, { headers: { Host: "localhost:5173" } });
    expect(response.headers.get("content-security-policy")).toContain(`connect-src localhost:5173${dirname(url)}/`);
    for (const host of ["localhost; script-src *", "localhost other.example", "evil.example/path", "user@evil.example"]) {
      const rejected = await request(url, { headers: { Host: host } });
      const policy = rejected.headers.get("content-security-policy")!;
      expect(policy).toContain(`connect-src localhost${dirname(url)}/`);
      expect(policy).not.toContain(host);
    }
  });
  it("supports HEAD and HTML entrypoints under hidden noncredential parents", async () => {
    const hiddenDir = join(root, ".worktrees", "feature", "artifacts");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(hiddenDir, "index.html"), "<p>worktree preview</p>");
    const created = await create(join(hiddenDir, "index.html"));
    expect(created.status).toBe(200);
    const url = (await created.json()).data.url;
    const response = await request(url, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("");
  });
  it("expires capabilities and rejects unknown ones", async () => {
    const url = await createUrl();
    time += 60 * 60 * 1000;
    expect((await request(url)).status).toBe(404);
    expect((await request("/api/html-preview/content/unknown/index.html")).status).toBe(404);
  });
  it("blocks traversal, hidden files, unsupported files and escaping directory symlinks", async () => {
    const base = dirname(await createUrl());
    writeFileSync(join(root, "secret.json"), '{"secret":true}');
    writeFileSync(join(root, "site", ".env.json"), "secret");
    writeFileSync(join(root, "site", "db.sqlite"), "secret");
    symlinkSync(root, join(root, "site", "escape"), process.platform === "win32" ? "junction" : "dir");
    for (const path of ["..%2fsecret.json", ".env.json", "db.sqlite", "escape/secret.json", "nested%5c..%5c..%5csecret.json"]) {
      expect((await request(`${base}/${path}`)).status).toBe(403);
    }
  });
  it("rejects credentials directories and non-HTML entrypoints", async () => {
    const secretFile = join(process.env.PPM_HOME!, "preview.html");
    writeFileSync(secretFile, "secret");
    expect((await create(secretFile)).status).toBe(403);
    expect((await create(join(root, "site", "app.js"))).status).toBe(400);
    expect((await create(join(root, "missing.html"))).status).toBe(404);
  });
});
