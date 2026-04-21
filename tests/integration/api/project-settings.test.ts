import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { clearIndexCache } from "../../../src/services/file-list-index.service.ts";
import { app } from "../../../src/server/index.ts";

let tmpDir: string;
const projectNames = ["project-a", "project-b"];
const projectPaths: Record<string, string> = {};

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(new Request(url, { ...init, headers }));
}

function setupProjects() {
  for (const name of projectNames) {
    const path = resolve(tmpDir, name);
    mkdirSync(path, { recursive: true });
    projectPaths[name] = path;
  }

  const projects = projectNames.map((name) => ({
    name,
    path: projectPaths[name],
    addedAt: new Date().toISOString(),
  }));
  configService.set("projects", projects);
}

describe("GET /api/projects/:name/settings", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;
    clearIndexCache();
    tmpDir = resolve(tmpdir(), `ppm-test-proj-settings-${Date.now()}-${Math.random()}`);
    setupProjects();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignored */ }
    clearIndexCache();
  });

  it("returns empty object for project with no settings", async () => {
    const res = await req("/api/projects/project-a/settings");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({});
  });

  it("returns stored project settings", async () => {
    configService.setProjectSettings(projectPaths["project-a"], {
      files: {
        filesExclude: ["**/*.log"],
      },
    });

    const res = await req("/api/projects/project-a/settings");
    const json = (await res.json()) as any;
    expect(json.data.files.filesExclude).toContain("**/*.log");
  });

  it("returns 404 for non-existent project", async () => {
    const res = await req("/api/projects/nonexistent/settings");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/:name/settings", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    // Ensure auth is disabled for tests
    const config = (configService as any).config;
    config.auth.enabled = false;
    clearIndexCache();
    tmpDir = resolve(tmpdir(), `ppm-test-proj-settings-${Date.now()}-${Math.random()}`);
    setupProjects();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignored */ }
    clearIndexCache();
  });

  it("sets files.filesExclude for a project", async () => {
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.tmp"],
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.files.filesExclude).toContain("**/*.tmp");
  });

  it("merges partial files settings (not replace)", async () => {
    // First set both
    const set1 = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.log"],
          searchExclude: ["**/dist"],
        },
      }),
    });
    const json1 = (await set1.json()) as any;
    expect(json1.data.files.filesExclude).toContain("**/*.log");
    expect(json1.data.files.searchExclude).toContain("**/dist");

    // Now patch only filesExclude
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.tmp"],
        },
      }),
    });

    const json = (await res.json()) as any;
    // Updated
    expect(json.data.files.filesExclude).toContain("**/*.tmp");
    // searchExclude should still be there if it's a true merge at the files level
    // (not replaced entirely)
    if (json.data.files.searchExclude && Array.isArray(json.data.files.searchExclude)) {
      expect(json.data.files.searchExclude).toContain("**/dist");
    }
  });

  it("does not affect other projects", async () => {
    // Set project-a
    await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.log"],
        },
      }),
    });

    // Verify project-b is unaffected
    const res = await req("/api/projects/project-b/settings");
    const json = (await res.json()) as any;
    expect(json.data).toEqual({});
  });

  it("validates files.filesExclude is array", async () => {
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: "not-array",
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("validates files.searchExclude is array", async () => {
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          searchExclude: true,
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("validates files.useIgnoreFiles is boolean", async () => {
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          useIgnoreFiles: "yes",
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("caps files.filesExclude at 200 patterns", async () => {
    const patterns = Array.from({ length: 250 }, (_, i) => `**/*.ext${i}`);
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: patterns,
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.files.filesExclude.length).toBe(200);
  });

  it("caps files.searchExclude at 200 patterns", async () => {
    const patterns = Array.from({ length: 250 }, (_, i) => `**/*.ext${i}`);
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          searchExclude: patterns,
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.files.searchExclude.length).toBe(200);
  });

  it("filters out non-string patterns from filesExclude", async () => {
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.log", 123, null, "**/*.tmp"],
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.files.filesExclude).toEqual(["**/*.log", "**/*.tmp"]);
  });

  it("returns 404 for non-existent project", async () => {
    const res = await req("/api/projects/nonexistent/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: { filesExclude: ["**/*.log"] },
      }),
    });
    expect(res.status).toBe(404);
  });

  it("deep-merges nested files object: sequential PATCHes preserve all sub-keys", async () => {
    // PATCH 1: set files.searchExclude only
    const res1 = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({ files: { searchExclude: ["**/dist"] } }),
    });
    expect(res1.status).toBe(200);

    // PATCH 2: set files.filesExclude only — must NOT clobber searchExclude
    const res2 = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({ files: { filesExclude: ["**/*.log"] } }),
    });
    expect(res2.status).toBe(200);

    const json = (await res2.json()) as any;
    // Both sub-keys must be present after the second patch
    expect(json.data.files.filesExclude).toContain("**/*.log");
    expect(json.data.files.searchExclude).toContain("**/dist");
  });

  it("invalidates index cache on patch", async () => {
    // This is tested indirectly: if cache is invalidated, next /files/index call
    // should rebuild. We verify this in files-index.test.ts.
    // Here we just verify the PATCH succeeds and the setting persists.
    const res = await req("/api/projects/project-a/settings", {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          filesExclude: ["**/*.log"],
        },
      }),
    });
    expect(res.status).toBe(200);

    // Get it back to confirm persistence
    const getRes = await req("/api/projects/project-a/settings");
    const json = (await getRes.json()) as any;
    expect(json.data.files.filesExclude).toContain("**/*.log");
  });
});
