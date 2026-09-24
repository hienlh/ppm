import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignPreviewRoutes } from "../../../src/server/routes/design-preview.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";

/**
 * What a design document gets is decided by its token's purpose alone. A print token is the
 * only way to `allow-modals` and the print script; a canvas token never gets either, whatever
 * the query string says; a standalone token gets the canvas CSP and nothing injected.
 */

const NONCE = "abcdefghijklmnop";
const INDEX = "<!doctype html><html><head><title>Deck</title></head><body><section class=\"slide\"><h1>One</h1></section></body></html>";

describe("design preview purposes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;
  const request = (path: string) => app.request(`http://localhost${path}`);
  const mint = async (purpose: string, slug = "deck") => {
    const res = await app.request("http://localhost/api/design-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer modes-test" },
      body: JSON.stringify({ projectName: "demo", slug, purpose }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()).data as { url: string }).url;
  };
  const load = async (url: string) => {
    const res = await request(url);
    return { csp: res.headers.get("content-security-policy") ?? "", html: await res.text(), status: res.status };
  };

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-modes-")));
    for (const [slug, kind] of [["deck", "slides"], ["page", "page"]] as const) {
      mkdirSync(join(project, "designs", slug), { recursive: true });
      writeFileSync(join(project, "designs", slug, "index.html"), INDEX);
      writeFileSync(join(project, "designs", slug, "design.json"), JSON.stringify({ title: slug, kind }));
    }
    const routes = createDesignPreviewRoutes();
    app = new Hono();
    app.route("/api/design-preview/content", routes.content);
    app.use("/api/*", authMiddleware);
    app.route("/api/design-preview", routes.api);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "modes-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("gives a print token allow-modals and the slide print view, and no bridge", async () => {
    const { csp, html, status } = await load(await mint("print"));
    expect(status).toBe(200);
    expect(csp).toStartWith("sandbox allow-scripts allow-modals;");
    expect(html).toContain("@page{size:1280px 720px;margin:0}");
    expect(html).toContain("window.print()");
    expect(html).not.toContain("data-ppm-bridge");
    expect(html).not.toContain("data-ppm-id");
    // Inside <head>, before the page's own content.
    expect(html.indexOf("<style data-ppm-print")).toBe(html.indexOf("<head>") + "<head>".length);
  });

  it("prints a page design with paper margins instead of slide pages", async () => {
    const { html } = await load(await mint("print", "page"));
    expect(html).toContain("@page{margin:12mm}");
    expect(html).not.toContain("1280px 720px");
  });

  it("never gives a canvas token allow-modals or the print view, whatever the query says", async () => {
    const url = await mint("canvas");
    for (const query of [`?n=${NONCE}`, `?n=${NONCE}&print=1`, "?purpose=print", "?mode=print&allowModals=1"]) {
      const { csp, html } = await load(url + query);
      expect(csp).toStartWith("sandbox allow-scripts;");
      expect(csp).not.toContain("allow-modals");
      expect(html).not.toContain("data-ppm-print");
      expect(html).toContain("data-ppm-bridge");
    }
  });

  it("serves a standalone token under the canvas CSP with nothing injected", async () => {
    const { csp, html } = await load(`${await mint("standalone")}?n=${NONCE}&print=1`);
    expect(csp).toStartWith("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-modals");
    expect(html).toBe(INDEX);
  });

  it("refuses to refresh a print or standalone token", async () => {
    for (const purpose of ["print", "standalone"]) {
      const url = await mint(purpose);
      const token = url.split("/")[4]!;
      const res = await app.request("http://localhost/api/design-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer modes-test" },
        body: JSON.stringify({ projectName: "demo", slug: "deck", purpose, token }),
      });
      expect(res.status).toBe(400);
    }
  });
});
