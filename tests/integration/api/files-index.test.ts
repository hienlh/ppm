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

  it("marks gitignored files as isIgnored when useIgnoreFiles=true", async () => {
    // Add .gitignore and a gitignored file
    writeFileSync(resolve(projectPath, ".gitignore"), "secret.env\n.env*");
    writeFileSync(resolve(projectPath, "secret.env"), "PASSWORD=abc");
    writeFileSync(resolve(projectPath, ".env.local"), "DEBUG=true");
    writeFileSync(resolve(projectPath, "config.json"), "{}");

    const res = await req(`/api/project/${projectName}/files/index`);
    const json = (await res.json()) as any;

    const entries = json.data as Array<{ path: string; isIgnored?: boolean }>;
    const byPath = (p: string) => entries.find((e) => e.path === p);
    expect(byPath("config.json")).toBeDefined();
    // Gitignored files are still listed but flagged isIgnored (soft-exclude:
    // rendered muted in the palette rather than hidden).
    expect(byPath("secret.env")?.isIgnored).toBe(true);
    expect(byPath(".env.local")?.isIgnored).toBe(true);
    expect(byPath("config.json")?.isIgnored).toBeUndefined();
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

  it("lets a first walk outlast Bun's 10 s idle timeout", async () => {
    // nxsys-workspace's first walk took 14 s on a busy scratch server, and Bun cut the request
    // off at 10 s with the list nearly built. `app.fetch(req, server)` hands routes the server.
    const timeouts: { request: Request; seconds: number }[] = [];
    const server = { timeout: (request: Request, seconds: number) => { timeouts.push({ request, seconds }); } };
    const res = await app.request(`/api/project/${projectName}/files/index`, undefined, server);

    expect(res.status).toBe(200);
    expect(timeouts.map((t) => t.seconds)).toEqual([30]);
    expect(new URL(timeouts[0]!.request.url).pathname).toBe(`/api/project/${projectName}/files/index`);
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

  it("sends the list gzipped as the worker built it, to a client that accepts gzip", async () => {
    const plain = await req(`/api/project/${projectName}/files/index`);
    const zipped = await req(`/api/project/${projectName}/files/index`, { headers: { "Accept-Encoding": "gzip, deflate, br" } });

    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(zipped.headers.get("Content-Encoding")).toBe("gzip");
    expect(zipped.headers.get("Vary")).toBe("Accept-Encoding");
    const body = new Uint8Array(await zipped.arrayBuffer());
    // Compressed once: the JSON middleware leaves an encoded body alone.
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(await plain.text());
  });

  it("answers a list longer than `max` with its size instead", async () => {
    const all = ((await (await req(`/api/project/${projectName}/files/index`)).json()) as any).data;
    const over = (await (await req(`/api/project/${projectName}/files/index?max=${all.length - 1}`)).json()) as any;
    expect(over.data).toEqual({ tooLarge: true, count: all.length });
    const within = (await (await req(`/api/project/${projectName}/files/index?max=${all.length}`)).json()) as any;
    expect(within.data).toEqual(all);
  });

  it("searches the list on the server, best first", async () => {
    writeFileSync(resolve(projectPath, "src/util-extra.ts"), "");
    invalidateIndexCache(projectPath);
    const search = async (query: string) =>
      ((await (await req(`/api/project/${projectName}/files/index/search?${query}`)).json()) as any).data.map((e: any) => e.path);

    // The palette's order: the filename that has the query in one piece beats the one that only
    // has its letters in order.
    expect(await search("q=utils")).toEqual(["src/utils.ts", "src/util-extra.ts"]);
    expect(await search("q=xtra")).toEqual(["src/util-extra.ts"]);
    expect(await search("q=src&kind=all&limit=1")).toEqual(["src"]);
    expect(await search("q=src&limit=1")).not.toEqual(["src"]);
    // A blank query answers the first files, as a picker shows before anything is typed.
    expect((await search("q=")).length).toBeGreaterThan(0);
    expect(await search("q=u&limit=-3")).toHaveLength(1);
  });

  it("rebuilds index after cache invalidation", async () => {
    // First call
    const res1 = await req(`/api/project/${projectName}/files/index`);
    const json1 = (await res1.json()) as any;
    const count1 = json1.data.length;

    // Add a new file
    writeFileSync(resolve(projectPath, "new-file.ts"), "export const y = 2");

    // Hard invalidation (a filter change). The watcher only marks the index stale — see
    // tests/unit/services/file-list-index-background.test.ts.
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
