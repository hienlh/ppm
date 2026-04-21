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

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(new Request(url, { ...init, headers }));
}

function setupProject() {
  // Create fixture structure
  mkdirSync(resolve(projectPath, "src"), { recursive: true });
  mkdirSync(resolve(projectPath, "node_modules"), { recursive: true });
  mkdirSync(resolve(projectPath, ".git"), { recursive: true });
  writeFileSync(resolve(projectPath, "README.md"), "# Test");
  writeFileSync(resolve(projectPath, "src/index.ts"), "console.log('hi')");
  writeFileSync(resolve(projectPath, "node_modules/pkg.txt"), "pkg");
  writeFileSync(resolve(projectPath, ".git/HEAD"), "ref");

  // Add project to config
  const projects = configService.get("projects");
  projects.push({
    name: projectName,
    path: projectPath,
    addedAt: new Date().toISOString(),
  });
  configService.set("projects", projects);
}

describe("GET /files/list", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;

    tmpDir = resolve(tmpdir(), `ppm-test-list-${Date.now()}-${Math.random()}`);
    projectPath = resolve(tmpDir, "project");
    projectName = `test-proj-${Date.now()}-${Math.random()}`;
    mkdirSync(projectPath, { recursive: true });
    setupProject();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignored */ }
  });

  it("returns root entries with readable files and directories", async () => {
    const res = await req(`/api/project/${projectName}/files/list?path=`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);

    const names = json.data.map((e: any) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    // Verify we have a mix of files and directories
    const types = json.data.map((e: any) => e.type);
    expect(types).toContain("file");
    expect(types).toContain("directory");
  });

  it("returns one-level children of src/", async () => {
    const res = await req(`/api/project/${projectName}/files/list?path=src`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);

    const names = json.data.map((e: any) => e.name);
    expect(names).toContain("index.ts");
    expect(names.length).toBe(1);
  });

  it("rejects path traversal with 400", async () => {
    const res = await req(`/api/project/${projectName}/files/list?path=../../etc/passwd`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(false);
  });

  it("returns 404 for non-existent path", async () => {
    const res = await req(`/api/project/${projectName}/files/list?path=nonexistent`);
    expect(res.status).toBe(404);
  });

  it("marks entries isIgnored based on .gitignore", async () => {
    // Add a .gitignore
    writeFileSync(resolve(projectPath, ".gitignore"), "*.log\nsecret.env");
    writeFileSync(resolve(projectPath, "debug.log"), "");
    writeFileSync(resolve(projectPath, "secret.env"), "");

    const res = await req(`/api/project/${projectName}/files/list?path=`);
    const json = (await res.json()) as any;

    const log = json.data.find((e: any) => e.name === "debug.log");
    const secret = json.data.find((e: any) => e.name === "secret.env");
    expect(log?.isIgnored).toBe(true);
    expect(secret?.isIgnored).toBe(true);
  });

  it("sorts directories before files alphabetically", async () => {
    writeFileSync(resolve(projectPath, "zz.txt"), "");
    mkdirSync(resolve(projectPath, "aaa"), { recursive: true });

    const res = await req(`/api/project/${projectName}/files/list?path=`);
    const json = (await res.json()) as any;

    const types = json.data.map((e: any) => e.type);
    const dirs = types.filter((t: string) => t === "directory");
    const files = types.filter((t: string) => t === "file");

    // All directories come before files
    const dirCount = dirs.length;
    expect(types.slice(0, dirCount).every((t: string) => t === "directory")).toBe(true);
    expect(types.slice(dirCount).every((t: string) => t === "file")).toBe(true);
  });
});
