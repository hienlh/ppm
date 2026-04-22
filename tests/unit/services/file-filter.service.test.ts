import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { setDb, openTestDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  resolveFilter,
  matchesGlob,
  HARDCODED_FILES_EXCLUDE,
  HARDCODED_SEARCH_EXCLUDE,
} from "../../../src/services/file-filter.service.ts";

let tmpDir: string;
let projectPath: string;

describe("file-filter.service", () => {
  beforeEach(() => {
    setDb(openTestDb());
    tmpDir = resolve(tmpdir(), `ppm-test-filter-${Date.now()}-${Math.random()}`);
    projectPath = resolve(tmpDir, "project");
    mkdirSync(projectPath, { recursive: true });
    // Initialize config fresh
    configService.load();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignored */ }
  });

  describe("matchesGlob", () => {
    it("matches **/.git patterns at any depth INCLUDING root", () => {
      // VS Code glob spec: **/X matches X at any depth, including root level
      expect(matchesGlob(".git", ["**/.git"])).toBe(true);         // root
      expect(matchesGlob("src/.git", ["**/.git"])).toBe(true);     // nested
      expect(matchesGlob("src/.git/HEAD", ["**/.git"])).toBe(true); // inside dir
      expect(matchesGlob("deep/src/.git", ["**/.git"])).toBe(true); // deeply nested
    });

    it("does not match partial .git names", () => {
      expect(matchesGlob("dotgit.txt", ["**/.git"])).toBe(false);
      expect(matchesGlob(".git.lock", ["**/.git"])).toBe(false);
      expect(matchesGlob(".gitignore", ["**/.git"])).toBe(false);
    });

    it("matches **/node_modules pattern at any depth INCLUDING root", () => {
      expect(matchesGlob("node_modules", ["**/node_modules"])).toBe(true);       // root
      expect(matchesGlob("src/node_modules", ["**/node_modules"])).toBe(true);   // nested
      expect(matchesGlob("a/b/node_modules", ["**/node_modules"])).toBe(true);   // deep
      expect(matchesGlob("node_modules/pkg", ["**/node_modules"])).toBe(true);   // contents
    });

    it("matches *.log pattern at any level (no slash means any depth)", () => {
      expect(matchesGlob("debug.log", ["*.log"])).toBe(true);
      expect(matchesGlob("src/debug.log", ["*.log"])).toBe(true);
      expect(matchesGlob("deep/nested/debug.log", ["*.log"])).toBe(true);
      expect(matchesGlob("debug.txt", ["*.log"])).toBe(false);
    });

    it("matches src/** pattern (all files under src)", () => {
      expect(matchesGlob("src/file.ts", ["src/**"])).toBe(true);
      expect(matchesGlob("src/subdir/file.ts", ["src/**"])).toBe(true);
      expect(matchesGlob("src/", ["src/**"])).toBe(true);
      expect(matchesGlob("lib/file.ts", ["src/**"])).toBe(false);
    });

    it("matches multiple patterns with OR logic", () => {
      const patterns = ["**/.git", "**/node_modules", "*.log"];
      expect(matchesGlob("src/.git/HEAD", patterns)).toBe(true); // matches **/.git
      expect(matchesGlob("src/node_modules/pkg", patterns)).toBe(true); // matches **/node_modules
      expect(matchesGlob("debug.log", patterns)).toBe(true); // matches *.log
      expect(matchesGlob("README.md", patterns)).toBe(false);
    });

    it("normalizes backslashes to forward slashes", () => {
      expect(matchesGlob("src\\file.ts", ["src/**"])).toBe(true);
      expect(matchesGlob("src\\subdir\\file.ts", ["src/**"])).toBe(true);
    });
  });

  describe("resolveFilter — precedence: hardcoded ⊂ global ⊂ project", () => {
    it("includes hardcoded defaults when global and project are empty", () => {
      const filter = resolveFilter(projectPath);
      expect(filter.filesExclude).toContain("**/.git");
      expect(filter.filesExclude).toContain("**/.DS_Store");
      expect(filter.searchExclude).toContain("**/node_modules");
      expect(filter.searchExclude).toContain("**/dist");
    });

    it("merges global config with hardcoded (dedup)", () => {
      // Set global filesExclude with new + overlapping pattern
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("files.exclude", JSON.stringify(["**/.git", "**/*.tmp"]));

      const filter = resolveFilter(projectPath);
      // Should have both hardcoded AND global (deduped)
      expect(filter.filesExclude).toContain("**/.git");
      expect(filter.filesExclude).toContain("**/*.tmp");
      expect(filter.filesExclude).toContain("**/.DS_Store");
      // Check for duplicates: set size = array length
      expect(new Set(filter.filesExclude).size).toBe(filter.filesExclude.length);
    });

    it("merges project override with global and hardcoded", () => {
      // Set global
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("files.exclude", JSON.stringify(["**/*.tmp"]));

      // Reload config to pick up DB change
      configService.load();

      // Set project-level override
      const { getDb } = require("../../../src/services/db.service.ts");
      const db = getDb();
      // Insert or update project row in DB
      db.query(
        "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET settings = ?"
      ).run("test-proj", projectPath, '{"files":{"filesExclude":["**/*.log"]}}', '{"files":{"filesExclude":["**/*.log"]}}');

      const filter = resolveFilter(projectPath);
      // Should have hardcoded + global + project
      expect(filter.filesExclude).toContain("**/.git"); // hardcoded
      expect(filter.filesExclude).toContain("**/*.tmp"); // global
      expect(filter.filesExclude).toContain("**/*.log"); // project
      expect(new Set(filter.filesExclude).size).toBe(filter.filesExclude.length);
    });

    it("project override replaces (not merges) when set", () => {
      // Global has .tmp
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("files.exclude", JSON.stringify(["**/*.tmp"]));

      configService.load();

      // Project has .log (different pattern)
      const { getDb } = require("../../../src/services/db.service.ts");
      const db = getDb();
      db.query(
        "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET settings = ?"
      ).run("test-proj", projectPath, '{"files":{"filesExclude":["**/*.log"]}}', '{"files":{"filesExclude":["**/*.log"]}}');

      const filter = resolveFilter(projectPath);
      // Should have: hardcoded + global + project
      expect(filter.filesExclude).toContain("**/.git"); // hardcoded
      expect(filter.filesExclude).toContain("**/*.tmp"); // global
      expect(filter.filesExclude).toContain("**/*.log"); // project
    });

    it("useIgnoreFiles: project override beats global", () => {
      const { setConfigValue, getDb } = require("../../../src/services/db.service.ts");
      setConfigValue("files.useIgnoreFiles", JSON.stringify(true));

      configService.load();

      // Set project override via DB
      const db = getDb();
      db.query(
        "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET settings = ?"
      ).run("test-proj", projectPath, '{"files":{"useIgnoreFiles":false}}', '{"files":{"useIgnoreFiles":false}}');

      const filter = resolveFilter(projectPath);
      expect(filter.useIgnoreFiles).toBe(false); // project wins
    });

    it("useIgnoreFiles: falls back to global when project not set", () => {
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("files.useIgnoreFiles", JSON.stringify(false));

      // Don't set project override

      const filter = resolveFilter(projectPath);
      expect(filter.useIgnoreFiles).toBe(false); // global applies
    });

    it("useIgnoreFiles: defaults to true when neither global nor project set", () => {
      // Don't set anything
      const filter = resolveFilter(projectPath);
      expect(filter.useIgnoreFiles).toBe(true); // default
    });
  });

  describe("resolveFilter — searchExclude", () => {
    it("includes hardcoded search excludes", () => {
      const filter = resolveFilter(projectPath);
      for (const pattern of HARDCODED_SEARCH_EXCLUDE) {
        expect(filter.searchExclude).toContain(pattern);
      }
    });

    it("merges global + project searchExclude", () => {
      const { setConfigValue, getDb } = require("../../../src/services/db.service.ts");
      setConfigValue("files.searchExclude", JSON.stringify(["**/secret/**"]));

      configService.load();

      // Set project override via DB
      const db = getDb();
      db.query(
        "INSERT INTO projects (name, path, settings) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET settings = ?"
      ).run("test-proj", projectPath, '{"files":{"searchExclude":[".env*"]}}', '{"files":{"searchExclude":[".env*"]}}');

      const filter = resolveFilter(projectPath);
      expect(filter.searchExclude).toContain("**/node_modules"); // hardcoded
      expect(filter.searchExclude).toContain("**/secret/**"); // global
      expect(filter.searchExclude).toContain(".env*"); // project
    });
  });
});
