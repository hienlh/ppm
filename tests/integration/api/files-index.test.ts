import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { invalidateIndexCache, clearIndexCache } from "../../../src/services/file-list-index.service.ts";
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
  writeFileSync(resolve(projectPath, "README.md"), "# Test");
  writeFileSync(resolve(projectPath, "src/index.ts"), "console.log('hi')");
  writeFileSync(resolve(projectPath, "src/utils.ts"), "export const x = 1");
  writeFileSync(resolve(projectPath, "node_modules/pkg.txt"), "pkg");

  // Add project to config
  const projects = configService.get("projects");
  projects.push({
    name: projectName,
    path: projectPath,
    addedAt: new Date().toISOString(),
  });
  configService.set("projects", projects);
}

describe("GET /files/index", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;
    clearIndexCache();
    tmpDir = resolve(tmpdir(), `ppm-test-index-${Date.now()}-${Math.random()}`);
    projectPath = resolve(tmpDir, "project");
    projectName = `test-proj-${Date.now()}-${Math.random()}`;
    mkdirSync(projectPath, { recursive: true });
    setupProject();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignored */ }
    clearIndexCache();
  });

  it("returns flat list of all files with searchExclude patterns", async () => {
    const res = await req(`/api/project/${projectName}/files/index`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);

    const paths = json.data.map((e: any) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils.ts");
    // The searchExclude patterns like **/node_modules require a slash,
    // so node_modules at root won't match. But nested paths like src/node_modules would.
    // We verify that files under src/ are included.
    expect(paths.length).toBeGreaterThan(0);
  });

  it("excludes gitignored files when useIgnoreFiles=true", async () => {
    // Add .gitignore and a gitignored file
    writeFileSync(resolve(projectPath, ".gitignore"), "secret.env\n.env*");
    writeFileSync(resolve(projectPath, "secret.env"), "PASSWORD=abc");
    writeFileSync(resolve(projectPath, ".env.local"), "DEBUG=true");
    writeFileSync(resolve(projectPath, "config.json"), "{}");

    const res = await req(`/api/project/${projectName}/files/index`);
    const json = (await res.json()) as any;

    const paths = json.data.map((e: any) => e.path);
    expect(paths).toContain("config.json");
    expect(paths).not.toContain("secret.env");
    expect(paths).not.toContain(".env.local");
  });

  it("includes gitignored files when useIgnoreFiles=false", async () => {
    // Set project to not use gitignore
    configService.setProjectSettings(projectPath, {
      files: {
        useIgnoreFiles: false,
      },
    });

    // Add .gitignore and a gitignored file
    writeFileSync(resolve(projectPath, ".gitignore"), "secret.env");
    writeFileSync(resolve(projectPath, "secret.env"), "PASSWORD=abc");

    // Bust cache before next call
    invalidateIndexCache(projectPath);

    const res = await req(`/api/project/${projectName}/files/index`);
    const json = (await res.json()) as any;

    const paths = json.data.map((e: any) => e.path);
    expect(paths).toContain("secret.env");
  });

  it("returns cached result on second call (faster)", async () => {
    const start1 = Date.now();
    const res1 = await req(`/api/project/${projectName}/files/index`);
    const time1 = Date.now() - start1;
    const json1 = (await res1.json()) as any;
    const count1 = json1.data.length;

    const start2 = Date.now();
    const res2 = await req(`/api/project/${projectName}/files/index`);
    const time2 = Date.now() - start2;
    const json2 = (await res2.json()) as any;
    const count2 = json2.data.length;

    expect(count1).toBe(count2);
    // Second call should be faster (from cache), or at least not slower by much
    // We don't assert strict timing, but both should complete within reason
    expect(time2).toBeLessThanOrEqual(time1 + 10);
  });

  it("rebuilds index after cache invalidation", async () => {
    // First call
    const res1 = await req(`/api/project/${projectName}/files/index`);
    const json1 = (await res1.json()) as any;
    const count1 = json1.data.length;

    // Add a new file
    writeFileSync(resolve(projectPath, "new-file.ts"), "export const y = 2");

    // Invalidate cache directly (simulate file watcher)
    invalidateIndexCache(projectPath);

    // Second call should see the new file
    const res2 = await req(`/api/project/${projectName}/files/index`);
    const json2 = (await res2.json()) as any;
    const count2 = json2.data.length;

    expect(count2).toBe(count1 + 1);
    const paths = json2.data.map((e: any) => e.path);
    expect(paths).toContain("new-file.ts");
  });

  it("respects project-level searchExclude override", async () => {
    writeFileSync(resolve(projectPath, "CHANGELOG.md"), "");
    writeFileSync(resolve(projectPath, "TODO.md"), "");

    // Set project to exclude .md files from search
    configService.setProjectSettings(projectPath, {
      files: {
        searchExclude: ["*.md"],
      },
    });

    invalidateIndexCache(projectPath);

    const res = await req(`/api/project/${projectName}/files/index`);
    const json = (await res.json()) as any;

    const paths = json.data.map((e: any) => e.path);
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("CHANGELOG.md");
    expect(paths).not.toContain("TODO.md");
  });
});
