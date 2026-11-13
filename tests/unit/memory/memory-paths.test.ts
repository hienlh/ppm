import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { projectKey } from "../../../src/services/project-name-for-path.ts";
import {
  embedInstallDir, ensureProjectMemoryDir, globalMemoryDir, memoryIndexPath, memoryRoot, projectMemoryDir, projectMemoryKey,
} from "../../../src/services/memory/memory-paths.ts";

const originalPpmHome = process.env.PPM_HOME;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-memory-paths-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

describe("memory paths", () => {
  it("keeps the store in the PPM directory, never the real home's ~/.ppm", () => {
    expect(memoryRoot()).toBe(join(resolve(home), "memory"));
    expect(memoryRoot().startsWith(resolve(homedir(), ".ppm"))).toBe(false);
  });

  it("puts global memories, the index and the local model install where the design says", () => {
    expect(globalMemoryDir()).toBe(join(resolve(home), "memory", "global"));
    expect(memoryIndexPath()).toBe(join(resolve(home), "memory", "index.db"));
    expect(embedInstallDir()).toBe(join(resolve(home), "memory-embed"));
  });

  it("names a project's folder by the first 16 hex of the sha256 of its projectKey", () => {
    const projectPath = "/work/some-project";
    const key = createHash("sha256").update(projectKey(projectPath)).digest("hex").slice(0, 16);
    expect(projectMemoryKey(projectPath)).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(projectMemoryDir(projectPath)).toBe(join(resolve(home), "memory", "projects", key));
  });

  it("gives every spelling of one folder the same directory, and two folders two directories", () => {
    expect(projectMemoryDir("/work/app/")).toBe(projectMemoryDir("/work/app"));
    expect(projectMemoryDir("/work/x/../app")).toBe(projectMemoryDir("/work/app"));
    expect(projectMemoryDir("/work/app")).not.toBe(projectMemoryDir("/work/app2"));
    expect(projectMemoryDir("/work/app")).not.toBe(globalMemoryDir());
  });

  it("does not create anything just to name a path", () => {
    const dir = projectMemoryDir("/work/never-created");
    expect(existsSync(dir)).toBe(false);
  });

  it("creates the project folder with a project.json naming the project path", async () => {
    const projectPath = "/work/with-json/";
    const dir = await ensureProjectMemoryDir(projectPath);
    expect(dir).toBe(projectMemoryDir(projectPath));
    expect(existsSync(dir)).toBe(true);
    const json = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    expect(json.path).toBe(resolve(projectPath));
  });

  it("is idempotent and leaves memory files in the folder alone", async () => {
    const dir = await ensureProjectMemoryDir("/work/again");
    writeFileSync(join(dir, "m-12345678.md"), "hello");
    expect(await ensureProjectMemoryDir("/work/again")).toBe(dir);
    expect(readFileSync(join(dir, "m-12345678.md"), "utf8")).toBe("hello");
    expect(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).path).toBe(resolve("/work/again"));
  });
});
