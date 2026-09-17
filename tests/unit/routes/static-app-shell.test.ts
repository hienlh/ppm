/**
 * The white-screen rule, exercised as real requests.
 *
 * `shouldServeAppShell` has its own unit tests, and they pass against code that
 * never calls it: replacing the call in `static.ts` with a constant left the
 * route suite byte-identical at 393 pass / 6 fail. The decision only exists
 * once a request carries a `Sec-Fetch-Dest` and a path, so that is what these
 * send — through Hono, against a real directory on disk.
 *
 * What the rule protects: an upgrade replaces `dist/web` and Vite's
 * `emptyOutDir` deletes the previous content hashes, so a tab open across the
 * upgrade asks for a chunk that is gone. Answered with `index.html` at
 * `200 text/html` the browser refuses the module on its strict MIME check and
 * React unmounts the tree; the service worker then caches that HTML under the
 * chunk's own URL and makes it permanent.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticHandler } from "../../../src/server/routes/static.ts";

let dist: string;
let app: Hono;

const SHELL = "<!doctype html><title>PPM</title><div id=root></div>";

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "ppm-static-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), SHELL);
  writeFileSync(join(dist, "assets", "index-abc123.js"), "export const x = 1;\n");
  app = new Hono();
  app.get("*", createStaticHandler(dist));
});

afterAll(() => rmSync(dist, { recursive: true, force: true }));

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`http://localhost${path}`, { headers });
}

describe("a missing chunk", () => {
  it("is a 404, not the app shell, when the browser says it wants a script", async () => {
    // The exact shape of the upgrade bug: the hash is gone from disk.
    const res = await get("/assets/index-deleted.js", { "Sec-Fetch-Dest": "script" });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type") ?? "").not.toContain("text/html");
    expect(await res.text()).not.toContain("<div id=root>");
  });

  it("is a 404 under /assets/ even with no Fetch Metadata at all", async () => {
    // Browsers omit `Sec-Fetch-*` on an insecure origin, and PPM is routinely
    // reached over plain HTTP on a LAN — which is where this bug was seen.
    const res = await get("/assets/index-deleted.js");

    expect(res.status).toBe(404);
  });

  it("is a 404 for a stylesheet, a worker and a font", async () => {
    for (const dest of ["style", "worker", "font", "image", "serviceworker"]) {
      const res = await get("/some/missing/thing", { "Sec-Fetch-Dest": dest });
      expect(res.status, `Sec-Fetch-Dest: ${dest}`).toBe(404);
    }
  });
});

describe("a navigation", () => {
  it("gets the app shell so deep links and reloads work", async () => {
    const res = await get("/project/x", { "Sec-Fetch-Dest": "document" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<div id=root>");
  });

  it("gets the app shell even when the path ends in .js", async () => {
    // The rule cannot be written on the path's shape: PPM's routes embed file
    // paths, so this is a navigation whose extension is `.js`.
    const res = await get("/project/x/editor/src/main.js", { "Sec-Fetch-Dest": "document" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root>");
  });

  it("gets the app shell when Fetch Metadata is absent outside /assets/", async () => {
    const res = await get("/project/x");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root>");
  });
});

describe("a file that is on disk", () => {
  it("is served with its own MIME type and an immutable cache header", async () => {
    const res = await get("/assets/index-abc123.js", { "Sec-Fetch-Dest": "script" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("application/javascript");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("export const x");
  });
});
