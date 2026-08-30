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

async function postBatch(body: unknown) {
  return app.request(
    new Request(`http://localhost/api/project/${projectName}/files/list-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function setupProject() {
  mkdirSync(resolve(projectPath, "src/web"), { recursive: true });
  mkdirSync(resolve(projectPath, "docs"), { recursive: true });
  writeFileSync(resolve(projectPath, "README.md"), "# Test");
  writeFileSync(resolve(projectPath, "src/index.ts"), "");
  writeFileSync(resolve(projectPath, "src/web/app.tsx"), "");
  writeFileSync(resolve(projectPath, "docs/guide.md"), "");

  const projects = configService.get("projects");
  projects.push({ name: projectName, path: projectPath, addedAt: new Date().toISOString() });
  configService.set("projects", projects);
}

describe("POST /files/list-batch", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    const config = (configService as any).config;
    config.auth.enabled = false;

    tmpDir = resolve(tmpdir(), `ppm-test-batch-${Date.now()}-${Math.random()}`);
    projectPath = resolve(tmpDir, "project");
    projectName = `test-proj-${Date.now()}-${Math.random()}`;
    mkdirSync(projectPath, { recursive: true });
    setupProject();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignored */ }
  });

  it("lists multiple directories in one request", async () => {
    const res = await postBatch({ paths: ["", "src", "src/web", "docs"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(4);

    const byPath = Object.fromEntries(json.data.map((r: any) => [r.path, r]));
    expect(byPath[""].entries.map((e: any) => e.name)).toContain("README.md");
    expect(byPath["src"].entries.map((e: any) => e.name)).toContain("index.ts");
    expect(byPath["src/web"].entries.map((e: any) => e.name)).toContain("app.tsx");
    expect(byPath["docs"].entries.map((e: any) => e.name)).toContain("guide.md");
  });

  it("returns per-path error for missing dir without failing the batch", async () => {
    const res = await postBatch({ paths: ["src", "does-not-exist"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const byPath = Object.fromEntries(json.data.map((r: any) => [r.path, r]));
    expect(byPath["src"].entries).toBeDefined();
    expect(byPath["does-not-exist"].error).toBeDefined();
    expect(byPath["does-not-exist"].entries).toBeUndefined();
  });

  it("rejects traversal paths with 400", async () => {
    const res = await postBatch({ paths: ["src", "../../etc"] });
    expect(res.status).toBe(400);
  });

  it("rejects more than 50 paths with 400", async () => {
    const res = await postBatch({ paths: Array.from({ length: 51 }, (_, i) => `p${i}`) });
    expect(res.status).toBe(400);
  });

  it("rejects empty or non-array paths with 400", async () => {
    expect((await postBatch({ paths: [] })).status).toBe(400);
    expect((await postBatch({ paths: "src" })).status).toBe(400);
    expect((await postBatch({})).status).toBe(400);
  });

  it("marks gitignored entries across batched paths", async () => {
    writeFileSync(resolve(projectPath, ".gitignore"), "*.log");
    writeFileSync(resolve(projectPath, "a.log"), "");
    writeFileSync(resolve(projectPath, "src/b.log"), "");

    const res = await postBatch({ paths: ["", "src"] });
    const json = (await res.json()) as any;
    const byPath = Object.fromEntries(json.data.map((r: any) => [r.path, r]));
    expect(byPath[""].entries.find((e: any) => e.name === "a.log")?.isIgnored).toBe(true);
    expect(byPath["src"].entries.find((e: any) => e.name === "b.log")?.isIgnored).toBe(true);
  });
});
