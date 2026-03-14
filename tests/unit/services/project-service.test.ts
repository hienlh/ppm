import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { ConfigService } from "../../../src/services/config.service.ts";
import { ProjectService } from "../../../src/services/project.service.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";
import { createTempDir, cleanupDir } from "../../setup.ts";

let tmpDir: string;
let configSvc: ConfigService;
let svc: ProjectService;

beforeEach(() => {
  tmpDir = createTempDir();
  configSvc = new ConfigService();
  (configSvc as unknown as { config: typeof DEFAULT_CONFIG }).config = {
    ...DEFAULT_CONFIG,
    projects: [],
  };
  (configSvc as unknown as { configPath: string }).configPath = join(tmpDir, "ppm.yaml");
  configSvc.save = () => {};
  svc = new ProjectService(configSvc);
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe("ProjectService.list()", () => {
  test("returns empty list when no projects", () => {
    expect(svc.list()).toEqual([]);
  });

  test("returns projects with hasGit=false for non-git dir", () => {
    const projDir = join(tmpDir, "myproject");
    mkdirSync(projDir);
    configSvc.set("projects", [{ path: projDir, name: "myproject" }]);
    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("myproject");
    expect(list[0].hasGit).toBe(false);
  });

  test("returns hasGit=true when .git dir exists", () => {
    const projDir = join(tmpDir, "gitproject");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    configSvc.set("projects", [{ path: projDir, name: "gitproject" }]);
    const list = svc.list();
    expect(list[0].hasGit).toBe(true);
  });
});

describe("ProjectService.add()", () => {
  test("adds a project with auto-derived name", () => {
    const projDir = join(tmpDir, "auto-name");
    mkdirSync(projDir);
    svc.add(projDir);
    expect(svc.list()[0].name).toBe("auto-name");
  });

  test("adds a project with explicit name", () => {
    const projDir = join(tmpDir, "some-dir");
    mkdirSync(projDir);
    svc.add(projDir, "custom");
    expect(svc.list()[0].name).toBe("custom");
  });

  test("throws when path already registered", () => {
    const projDir = join(tmpDir, "dup");
    mkdirSync(projDir);
    svc.add(projDir);
    expect(() => svc.add(projDir)).toThrow();
  });

  test("throws when name already registered", () => {
    const dir1 = join(tmpDir, "p1");
    const dir2 = join(tmpDir, "p2");
    mkdirSync(dir1); mkdirSync(dir2);
    svc.add(dir1, "same-name");
    expect(() => svc.add(dir2, "same-name")).toThrow();
  });
});

describe("ProjectService.remove()", () => {
  test("removes project by name", () => {
    const projDir = join(tmpDir, "removable");
    mkdirSync(projDir);
    svc.add(projDir, "removable");
    svc.remove("removable");
    expect(svc.list()).toHaveLength(0);
  });

  test("removes project by path", () => {
    const projDir = join(tmpDir, "by-path");
    mkdirSync(projDir);
    svc.add(projDir);
    svc.remove(projDir);
    expect(svc.list()).toHaveLength(0);
  });

  test("throws when project not found", () => {
    expect(() => svc.remove("nonexistent")).toThrow();
  });
});

describe("ProjectService.resolve()", () => {
  test("resolves by name", () => {
    const projDir = join(tmpDir, "resolve-me");
    mkdirSync(projDir);
    svc.add(projDir, "resolve-me");
    const p = svc.resolve("resolve-me");
    expect(p.name).toBe("resolve-me");
  });

  test("resolves by absolute path", () => {
    const projDir = join(tmpDir, "abs-resolve");
    mkdirSync(projDir);
    svc.add(projDir);
    const p = svc.resolve(projDir);
    expect(p.path).toBe(projDir);
  });

  test("throws when not found", () => {
    expect(() => svc.resolve("ghost")).toThrow();
  });

  test("resolves by CWD when no argument", () => {
    const projDir = join(tmpDir, "cwd-proj");
    mkdirSync(projDir);
    svc.add(projDir);
    const origCwd = process.cwd;
    process.cwd = () => projDir;
    try {
      const p = svc.resolve();
      expect(p.path).toBe(projDir);
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("ProjectService.scanForGitRepos()", () => {
  test("finds .git directories", async () => {
    const repoDir = join(tmpDir, "scandir", "repo1");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, "file.txt"), "");
    const results = svc.scanForGitRepos(join(tmpDir, "scandir"));
    expect(results).toContain(repoDir);
  });

  test("does not recurse into git repos", () => {
    const repoDir = join(tmpDir, "nrecurse", "repo");
    const nested = join(repoDir, "inner");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    mkdirSync(join(nested, ".git"), { recursive: true });
    const results = svc.scanForGitRepos(join(tmpDir, "nrecurse"));
    expect(results).toContain(repoDir);
    expect(results).not.toContain(nested);
  });

  test("returns empty list when no git repos found", () => {
    const emptyDir = join(tmpDir, "empty-scan");
    mkdirSync(emptyDir);
    expect(svc.scanForGitRepos(emptyDir)).toEqual([]);
  });
});
