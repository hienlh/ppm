import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { clearIndexCache, buildIndex } from "../../../src/services/file-list-index.service.ts";
import { app } from "../../../src/server/index.ts";

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(new Request(url, { ...init, headers }));
}

let tmpDir: string;

describe("GET /api/settings/files", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;
    clearIndexCache();
    tmpDir = resolve(tmpdir(), `ppm-test-files-settings-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    clearIndexCache();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignored */ }
  });

  it("returns empty arrays and default useIgnoreFiles", async () => {
    const res = await req("/api/settings/files");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.filesExclude).toEqual([]);
    expect(json.data.searchExclude).toEqual([]);
    expect(json.data.useIgnoreFiles).toBe(true);
  });

  it("returns previously stored patterns", async () => {
    // Set via direct API call
    const patchRes = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: ["**/*.tmp", "**/.cache"],
      }),
    });
    expect(patchRes.status).toBe(200);

    // Now GET should return them
    const getRes = await req("/api/settings/files");
    const json = (await getRes.json()) as any;
    expect(json.data.filesExclude).toContain("**/*.tmp");
    expect(json.data.filesExclude).toContain("**/.cache");
  });
});

describe("PATCH /api/settings/files", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;
    clearIndexCache();
    tmpDir = resolve(tmpdir(), `ppm-test-files-settings-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    clearIndexCache();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignored */ }
  });

  it("updates filesExclude", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: ["**/*.log", "**/*.bak"],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.filesExclude).toContain("**/*.log");
    expect(json.data.filesExclude).toContain("**/*.bak");
  });

  it("updates searchExclude", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        searchExclude: ["**/target", "**/.gradle"],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.searchExclude).toContain("**/target");
    expect(json.data.searchExclude).toContain("**/.gradle");
  });

  it("updates useIgnoreFiles", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        useIgnoreFiles: false,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.useIgnoreFiles).toBe(false);
  });

  it("validates filesExclude is an array", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: "not-an-array",
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(false);
  });

  it("validates searchExclude is an array", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        searchExclude: 123,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("validates useIgnoreFiles is a boolean", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        useIgnoreFiles: "yes",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("caps filesExclude at 200 patterns", async () => {
    const patterns = Array.from({ length: 250 }, (_, i) => `**/*.ext${i}`);
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: patterns,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.filesExclude.length).toBe(200);
  });

  it("caps searchExclude at 200 patterns", async () => {
    const patterns = Array.from({ length: 250 }, (_, i) => `**/*.ext${i}`);
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        searchExclude: patterns,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.searchExclude.length).toBe(200);
  });

  it("filters out non-string patterns", async () => {
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: ["**/*.log", 123, null, "**/*.tmp"],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.filesExclude).toEqual(["**/*.log", "**/*.tmp"]);
  });

  it("invalidates index cache after PATCH so next buildIndex reflects new filters", async () => {
    // Set up a minimal project directory with one file
    const projectPath = resolve(tmpDir, "proj");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(resolve(projectPath, "keep.ts"), "");
    writeFileSync(resolve(projectPath, "skip.log"), "");

    // Prime the index cache — should include both files
    const initialIndex = buildIndex(projectPath);
    const initialFiles = initialIndex.filter((e) => e.type === "file").map((e) => e.path);
    expect(initialFiles).toContain("keep.ts");
    expect(initialFiles).toContain("skip.log");

    // PATCH global filesExclude to exclude .log files (use *.log to match root-level files too)
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({ filesExclude: ["*.log"] }),
    });
    expect(res.status).toBe(200);

    // After PATCH, the cache should be cleared — next buildIndex rebuilds with new filters
    // We can't use the route here (route uses per-project path), so we verify the cache
    // was cleared by checking buildIndex() rebuilds (not returning stale cached result)
    const postPatchIndex = buildIndex(projectPath);
    const postPatchFiles = postPatchIndex.filter((e) => e.type === "file").map((e) => e.path);
    expect(postPatchFiles).toContain("keep.ts");
    expect(postPatchFiles).not.toContain("skip.log");
  });

  it("patches partially (only updates specified fields)", async () => {
    // First set both
    await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: ["**/*.log"],
        searchExclude: ["**/dist"],
        useIgnoreFiles: true,
      }),
    });

    // Now patch only filesExclude
    const res = await req("/api/settings/files", {
      method: "PATCH",
      body: JSON.stringify({
        filesExclude: ["**/*.tmp"],
      }),
    });

    const json = (await res.json()) as any;
    expect(json.data.filesExclude).toContain("**/*.tmp");
    expect(json.data.searchExclude).toContain("**/dist"); // unchanged
    expect(json.data.useIgnoreFiles).toBe(true); // unchanged
  });
});
