/**
 * Design screenshots end to end with a real browser: the design's variants served by the real
 * preview route under one-shot `standalone` tokens, rendered by the Chrome, Edge or Chromium this
 * machine has, kept under the PPM folder and served by id. Skipped where no such browser exists
 * (the e2e image has its own Chromium and runs it there).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignPreviewRoutes } from "../../src/server/routes/design-preview.ts";
import { designShotRoutes } from "../../src/server/routes/design-shots.ts";
import {
  captureDesignShots, readShot, shotRequestAllowed, shotsDir, type ShotDeps,
} from "../../src/services/design/shots/design-shots.service.ts";
import { findHeadlessBrowser } from "../../src/services/design/shots/headless-browser.ts";

const browser = findHeadlessBrowser();
// A project may not live inside the PPM folder: the design paths refuse it.
const projectPath = mkdtempSync(join(tmpdir(), "ppm-shots-project-"));
const preview = createDesignPreviewRoutes();
const app = new Hono();
app.route("/api/design-preview/content", preview.content);
app.route("/api/design-shots", designShotRoutes);
let server: ReturnType<typeof Bun.serve>;
let deps: ShotDeps;
// Stands for something on the server's network the design must never reach (a LAN service, metadata).
const internalHits: string[] = [];
const internal = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { internalHits.push(new URL(req.url).pathname); return new Response("SECRET"); } });

const page = (bg: string, words: string) =>
  `<!doctype html><html><body style="margin:0;background:${bg}"><h1 style="font:40px sans-serif;color:#fff;padding:40px">${words}</h1>`
  + `<div style="height:1400px"></div></body></html>`;

beforeAll(() => {
  const dir = join(projectPath, "designs", "kho-task");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "design.json"), JSON.stringify({
    title: "Kho task", kind: "page", entry: "index.html",
    variants: [{ file: "index.html", label: "Light" }, { file: "variant-2.html", label: "Dark" }],
  }));
  writeFileSync(join(dir, "index.html"), page("#2563eb", "Light"));
  writeFileSync(join(dir, "variant-2.html"), page("#111827", "Dark"));
  const probe = join(projectPath, "designs", "probe");
  mkdirSync(probe, { recursive: true });
  writeFileSync(join(probe, "design.json"), JSON.stringify({
    title: "Probe", entry: "index.html", variants: [{ file: "index.html" }, { file: "leave.html" }],
  }));
  // Loads from the internal address in every way a page can, and still renders.
  writeFileSync(join(probe, "index.html"), `<!doctype html><body style="background:#fff"><h1>Probe</h1>`
    + `<img src="http://127.0.0.1:${internal.port}/img"><link rel="stylesheet" href="http://127.0.0.1:${internal.port}/css">`
    + `<script>fetch("http://127.0.0.1:${internal.port}/fetch").catch(() => {});</script></body>`);
  // Sends itself to the internal address.
  writeFileSync(join(probe, "leave.html"), `<!doctype html><script>location.href = "http://127.0.0.1:${internal.port}/navigate";</script>`);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  deps = {
    mintStandalone: (path, slug) => preview.store.mint({ projectPath: path, slug }, "standalone"),
    baseUrl: () => `http://127.0.0.1:${server.port}`,
    browser: () => browser,
  };
});
afterAll(() => {
  server?.stop(true);
  internal.stop(true);
  rmSync(projectPath, { recursive: true, force: true });
});

describe.skipIf(!browser)("design screenshots with a real browser", () => {
  it("renders every variant to PNG, full height, and serves each by its id alone", async () => {
    const shots = await captureDesignShots(projectPath, "kho-task", undefined, deps);
    expect(shots.map((s) => [s.file, s.label])).toEqual([["index.html", "Light"], ["variant-2.html", "Dark"]]);
    for (const shot of shots) {
      expect(Array.from(shot.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // The whole page, not one viewport: the body is ~1460px tall.
      expect(shot.height).toBeGreaterThan(1400);
      expect(await readShot(shot.id)).toMatchObject({ id: shot.id, slug: "kho-task", projectPath });
      const res = await app.request(`/api/design-shots/${shot.id}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(shot.png.byteLength);
    }
    // Two different pages make two different pictures.
    expect(Buffer.from(shots[0]!.png).equals(Buffer.from(shots[1]!.png))).toBe(false);
  }, 60_000);

  it("renders only the variants named, and refuses one the design does not have", async () => {
    const shots = await captureDesignShots(projectPath, "kho-task", ["variant-2.html"], deps);
    expect(shots.map((s) => s.file)).toEqual(["variant-2.html"]);
    await expect(captureDesignShots(projectPath, "kho-task", ["nope.html"], deps)).rejects.toThrow('no variant "nope.html"');
  }, 60_000);
});

describe.skipIf(!browser)("what a design page may reach while it is rendered", () => {
  it("blocks every request to anything but its own files and the design CDNs, and never pictures a page that left", async () => {
    const [shot] = await captureDesignShots(projectPath, "probe", ["index.html"], deps);
    expect(shot!.file).toBe("index.html");
    await expect(captureDesignShots(projectPath, "probe", ["leave.html"], deps)).rejects.toThrow();
    expect(internalHits).toEqual([]);
  }, 60_000);

  it("allows only the token's own prefix, inline data and the CDN hosts over https", () => {
    const own = "http://127.0.0.1:1/api/design-preview/content/tok/";
    expect(shotRequestAllowed(`${own}kho/index.html`, own)).toBe(true);
    expect(shotRequestAllowed("data:image/png;base64,AAAA", own)).toBe(true);
    expect(shotRequestAllowed("https://cdn.jsdelivr.net/npm/x", own)).toBe(true);
    expect(shotRequestAllowed("http://cdn.jsdelivr.net/npm/x", own)).toBe(false);
    expect(shotRequestAllowed("http://127.0.0.1:1/api/design-preview/content/other/kho/index.html", own)).toBe(false);
    expect(shotRequestAllowed("http://169.254.169.254/latest/meta-data", own)).toBe(false);
    expect(shotRequestAllowed("file:///etc/passwd", own)).toBe(false);
  });
});

describe("design screenshot links", () => {
  it("answer 404 for an unknown id or anything that is not one", async () => {
    mkdirSync(shotsDir(), { recursive: true });
    for (const path of [`${"e".repeat(32)}.png`, "..%2Fppm.db", `${"e".repeat(32)}.json`, "x.png"]) {
      expect((await app.request(`/api/design-shots/${path}`)).status).toBe(404);
    }
  });

  it("refuses a capture when no browser can be found, saying so", async () => {
    await expect(captureDesignShots(projectPath, "kho-task", undefined, { ...deps, browser: () => null })).rejects.toThrow("No Chrome, Edge or Chromium");
  });
});
