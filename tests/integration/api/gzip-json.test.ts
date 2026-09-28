import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import { Hono } from "hono";
import { gzipJson } from "../../../src/server/middleware/gzip-json.ts";

let tmpDir: string;
let projectPath: string;
let projectName: string;

async function get(path: string, headers: Record<string, string> = {}) {
  return app.request(new Request(`http://localhost${path}`, { headers }));
}

describe("gzip-json middleware", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    const config = (configService as any).config;
    config.auth.enabled = false;

    tmpDir = resolve(tmpdir(), `ppm-test-gzip-${Date.now()}-${Math.random()}`);
    projectPath = resolve(tmpDir, "project");
    projectName = `test-proj-${Date.now()}-${Math.random()}`;
    mkdirSync(resolve(projectPath, "src"), { recursive: true });
    // >1KB of listable content so the response crosses the compression threshold
    for (let i = 0; i < 60; i++) {
      writeFileSync(resolve(projectPath, `file-with-a-reasonably-long-name-${i}.ts`), "");
    }

    const projects = configService.get("projects");
    projects.push({ name: projectName, path: projectPath, addedAt: new Date().toISOString() });
    configService.set("projects", projects);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignored */ }
  });

  it("gzips large JSON responses when client accepts gzip", async () => {
    const res = await get(`/api/project/${projectName}/files/list?path=`, { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");

    // Body must decompress back to valid JSON
    const gzipped = new Uint8Array(await res.arrayBuffer());
    const json = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gzipped)));
    expect(json.ok).toBe(true);
    expect(json.data.length).toBeGreaterThan(50);
  });

  it("does not gzip when client does not accept gzip", async () => {
    const res = await get(`/api/project/${projectName}/files/list?path=`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
  });

  it("does not gzip small JSON responses", async () => {
    const res = await get(`/api/health`, { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
  });
});

/** The longest the event loop went without running a 1 ms timer while `work` ran. */
async function worstTimerGapDuring(work: () => Promise<unknown>): Promise<number> {
  let worst = 0;
  let last = performance.now();
  let ticking = true;
  const tick = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (ticking) setTimeout(tick, 1);
  };
  tick();
  await work();
  ticking = false;
  // A synchronous gzip can run entirely inside microtasks, ending before any timer fires again.
  return Math.max(worst, performance.now() - last);
}

describe("gzip-json middleware on a large body", () => {
  // Paths like a big project's file index, and about as long as nxsys-workspace's (22 MB), so the
  // blocking a synchronous gzip would cost stays well clear of a coarse Windows timer tick.
  const big = JSON.stringify({ ok: true, data: Array.from({ length: 260_000 }, (_, i) => ({ path: `packages/app-${i % 97}/src/module-${i}/index.ts`, name: "index.ts", type: "file" })) });
  const bigApp = new Hono();
  bigApp.use("*", gzipJson);
  bigApp.get("/big", (c) => c.body(big, 200, { "Content-Type": "application/json" }));

  it("compresses it off the event loop, so other requests are not kept waiting", async () => {
    // Calibrate against this machine: how long the synchronous call would stop the loop.
    const bytes = new TextEncoder().encode(big);
    const started = performance.now();
    Bun.gzipSync(bytes);
    const blockingMs = performance.now() - started;

    // The probe's own floor: about 1 ms on Linux and macOS, but Windows keeps a coarse timer
    // (15.6 ms by default), which on its own would use up the margin below.
    const idleGapMs = await worstTimerGapDuring(() => Bun.sleep(100));

    let res!: Response;
    let body!: Uint8Array;
    const worstGapMs = await worstTimerGapDuring(async () => {
      res = await bigApp.request("/big", { headers: { "Accept-Encoding": "gzip" } });
      body = new Uint8Array(await res.arrayBuffer());
    });

    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(big);
    expect(Number(res.headers.get("Content-Length"))).toBe(body.byteLength);
    expect(worstGapMs).toBeLessThan(idleGapMs + blockingMs / 2);
  });
});
