import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";

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
