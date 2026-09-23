import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignPreviewRoutes } from "../../../src/server/routes/design-preview.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { CANVAS_IDLE_TTL } from "../../../src/services/design/preview/design-preview-tokens.ts";

const NONCE = "abcdefghijklmnop";
const INDEX = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"><link rel=\"stylesheet\" href=\"../tokens.css\"></head><body><h1>Hi</h1><p>x</p></body></html>";

describe("design preview route", () => {
  let project: string;
  let app: Hono;
  let time: number;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  const request = (path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init);
  const mint = (body: Record<string, unknown>, auth = true) => request("/api/design-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-preview-test" } : {}) },
    body: JSON.stringify(body),
  });
  const mintData = async (body: Record<string, unknown> = {}) => {
    const response = await mint({ projectName: "demo", slug: "landing", purpose: "canvas", ...body });
    expect(response.status).toBe(200);
    return (await response.json()).data as { url: string; token: string; expiresAt: number; rotated: boolean };
  };
  const base = (url: string) => url.slice(0, url.lastIndexOf("/landing/"));

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-preview-")));
    const designs = join(project, "designs");
    mkdirSync(join(designs, "landing", ".design"), { recursive: true });
    mkdirSync(join(designs, "other"), { recursive: true });
    writeFileSync(join(designs, "landing", "index.html"), INDEX);
    writeFileSync(join(designs, "landing", "styles.css"), "﻿h1{color:red}");
    writeFileSync(join(designs, "landing", "hero.png"), "0123456789");
    writeFileSync(join(designs, "landing", "design.json"), JSON.stringify({ title: "Landing", kind: "page" }));
    writeFileSync(join(designs, "landing", ".design", "comments.json"), "[]");
    writeFileSync(join(designs, "other", "index.html"), "<p>other design</p>");
    writeFileSync(join(designs, "tokens.css"), ":root{--accent:#f00}");
    time = 1_000_000;
    const routes = createDesignPreviewRoutes(() => time);
    app = new Hono();
    app.route("/api/design-preview/content", routes.content);
    app.use("/api/*", authMiddleware);
    app.route("/api/design-preview", routes.api);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "design-preview-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("mints only for an authenticated caller and a valid body", async () => {
    expect((await mint({ projectName: "demo", slug: "landing", purpose: "canvas" }, false)).status).toBe(401);
    for (const body of [{}, { projectName: "demo", slug: "Landing", purpose: "canvas" }, { projectName: "demo", slug: "landing" },
      { projectName: "demo", slug: "landing", purpose: "admin" }, { projectName: "demo", slug: "landing", purpose: "canvas", token: 5 }]) {
      expect((await mint(body)).status).toBe(400);
    }
    expect((await mint({ projectName: "nope", slug: "landing", purpose: "canvas" })).status).toBe(404);
    expect((await mint({ projectName: "demo", slug: "missing", purpose: "canvas" })).status).toBe(404);
    const data = await mintData();
    expect(data.url).toBe(`/api/design-preview/content/${data.token}/landing/index.html`);
    expect(data).toMatchObject({ expiresAt: time + CANVAS_IDLE_TTL, rotated: false });
    expect(data.url).not.toContain("design-preview-test");
  });

  it("serves instrumented HTML under the design CSP with the gen and ACAO null", async () => {
    const { url } = await mintData();
    const response = await request(`${url}?n=${NONCE}`, { headers: { Host: "localhost:5173" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-ppm-gen")).toBe(computeGen(INDEX));
    expect(response.headers.get("x-ppm-instrumented")).toBe("1");
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain(`connect-src localhost:5173${base(url)}/;`);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("allow-modals");
    const html = await response.text();
    expect(html).toContain(`<h1 data-ppm-id="${INDEX.indexOf("<h1")}">`);
    expect(html).toContain(`data-nonce="${NONCE}"`);
    // Only the design's own stylesheet carries a gen; the shared tokens file is not writable from the canvas.
    expect(html).toContain(`data-css-gens="{&quot;styles.css&quot;:&quot;${computeGen("h1{color:red}")}&quot;}"`);
    // First thing inside <head>, ahead of every stylesheet and script.
    const headOpen = html.indexOf(">", html.indexOf("<head")) + 1;
    expect(html.indexOf("<script data-ppm-bridge")).toBe(headOpen);
  });

  it("drops a malformed nonce, so the bridge reports null", async () => {
    const { url } = await mintData();
    for (const n of ["short", "has%20space%20in%20it%20ok", "\"><script>x</script>"]) {
      const html = await (await request(`${url}?n=${encodeURIComponent(n)}`)).text();
      expect(html).toContain('data-nonce=""');
    }
  });

  it("gives CSS a gen and serves other assets with ranges", async () => {
    const { url } = await mintData();
    const css = await request(`${base(url)}/landing/styles.css`);
    expect(css.headers.get("x-ppm-gen")).toBe(computeGen("h1{color:red}"));
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("access-control-allow-origin")).toBe("null");
    const tokens = await request(`${base(url)}/tokens.css`);
    expect(await tokens.text()).toBe(":root{--accent:#f00}");
    const png = await request(`${base(url)}/landing/hero.png`, { headers: { Range: "bytes=2-5" } });
    expect(png.status).toBe(206);
    expect(await png.text()).toBe("2345");
    expect((await request(url, { method: "HEAD" })).headers.get("x-ppm-gen")).toBe(computeGen(INDEX));
  });

  it("refuses another design, dot-directories and traversal with this token", async () => {
    const { url } = await mintData();
    for (const path of ["other/index.html", "landing/.design/comments.json", "landing/..%2fother%2findex.html", "DESIGN.md"]) {
      expect((await request(`${base(url)}/${path}`)).status).toBe(403);
    }
    expect((await request(`${base(url)}/landing/missing.png`)).status).toBe(404);
  });

  it("answers a dead token with the expired page for HTML and JSON otherwise", async () => {
    const { url } = await mintData();
    time += CANVAS_IDLE_TTL;
    const response = await request(`${url}?n=${NONCE}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await response.text();
    expect(html).toContain(`"type":"expired"`);
    expect(html).toContain(`"nonce":"${NONCE}"`);
    const css = await request(`${base(url)}/landing/styles.css`);
    expect(css.status).toBe(404);
    expect(css.headers.get("content-type")).toContain("application/json");
  });

  it("extends only through the authenticated refresh, for the same design", async () => {
    const { token } = await mintData();
    time += 20 * 60 * 1000;
    const refreshed = await mintData({ token });
    expect(refreshed).toMatchObject({ token, rotated: false, expiresAt: time + CANVAS_IDLE_TTL });
    expect((await mint({ projectName: "demo", slug: "landing", purpose: "canvas", token }, false)).status).toBe(401);
    writeFileSync(join(project, "designs", "other", "design.json"), "{}");
    expect((await mint({ projectName: "demo", slug: "other", purpose: "canvas", token })).status).toBe(403);
    expect((await mint({ projectName: "demo", slug: "landing", purpose: "print", token })).status).toBe(400);
    expect((await mint({ projectName: "demo", slug: "landing", purpose: "canvas", token: "unknown" })).status).toBe(404);
  });

  it("keeps ACAO null behind the app's global CORS layer, which would answer * on its own", async () => {
    const routes = createDesignPreviewRoutes(() => time);
    const withCors = new Hono();
    withCors.use("*", cors());
    withCors.route("/api/design-preview/content", routes.content);
    withCors.use("/api/*", authMiddleware);
    withCors.route("/api/design-preview", routes.api);
    const minted = await withCors.request("http://localhost/api/design-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer design-preview-test" },
      body: JSON.stringify({ projectName: "demo", slug: "landing", purpose: "canvas" }),
    });
    const { url } = (await minted.json()).data as { url: string };
    for (const path of [url, `${base(url)}/landing/styles.css`, `${base(url)}/landing/hero.png`, `${base(url)}/other/index.html`]) {
      const response = await withCors.request(`http://localhost${path}`, { headers: { Origin: "null" } });
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
    }
    time += CANVAS_IDLE_TTL;
    const expired = await withCors.request(`http://localhost${url}`, { headers: { Origin: "null" } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("serves print documents with modals and no bridge", async () => {
    const { url } = await mintData({ purpose: "print" });
    const response = await request(url);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-modals");
    const html = await response.text();
    expect(html).toBe(INDEX);
  });

  it("serves an oversized page uninstrumented but still with the bridge", async () => {
    const big = `<!doctype html><body>${"<p>filler</p>".repeat(Math.ceil((5 * 1024 * 1024) / 13) + 10)}</body>`;
    writeFileSync(join(project, "designs", "landing", "index.html"), big);
    const { url } = await mintData();
    const response = await request(`${url}?n=${NONCE}`);
    expect(response.headers.get("x-ppm-instrumented")).toBe("0");
    const html = await response.text();
    expect(html.startsWith("<!doctype html><script data-ppm-bridge=\"1\"")).toBe(true);
    expect(html).toContain('data-instrumented="0"');
    expect(html.slice(html.indexOf("</script>"))).not.toContain("data-ppm-id=");
  });
});
