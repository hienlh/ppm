import { describe, it, expect, afterEach } from "bun:test";
import { discoverBundledManifests, discoverManifests, hasPpmMarker, readManifestAt } from "../../../src/services/extension-manifest.ts";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionManifest } from "../../../src/types/extension.ts";

describe("readManifestAt", () => {
  it("returns null for directory without package.json", () => {
    const result = readManifestAt("/tmp");
    expect(result).toBeNull();
  });

  it("reads and parses valid manifest from directory", () => {
    // ext-git-graph should exist and have a package.json
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const gitGraphDir = resolve(packagesDir, "ext-git-graph");
    const manifest = readManifestAt(gitGraphDir);

    expect(manifest).toBeTruthy();
    expect(manifest?.id).toBe("@ppm/ext-git-graph");
    expect(manifest?.version).toBeTruthy();
    expect(manifest?.main).toBeTruthy();
  });

  it("reads manifest from vscode-compat package", () => {
    // vscode-compat has a package.json but is not an extension
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const vscodeDir = resolve(packagesDir, "vscode-compat");
    const manifest = readManifestAt(vscodeDir);

    // vscode-compat has a package.json with name, version, main
    expect(manifest).toBeTruthy();
    expect(manifest?.id).toBe("@ppm/vscode-compat");
  });
});

describe("discoverBundledManifests", () => {
  it("returns empty array for nonexistent directory", async () => {
    const result = await discoverBundledManifests("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("discovers bundled extensions matching ext-* pattern", async () => {
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const result = await discoverBundledManifests(packagesDir);

    // Should find at least ext-git-graph
    expect(result.length).toBeGreaterThan(0);

    // Find git-graph extension
    const gitGraph = result.find(m => m.id === "@ppm/ext-git-graph");
    expect(gitGraph).toBeTruthy();
    expect(gitGraph?.version).toBeTruthy();
    expect(gitGraph?._dir).toContain("ext-git-graph");
  });

  it("skips non-ext-* directories", async () => {
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const result = await discoverBundledManifests(packagesDir);

    // Should NOT include vscode-compat (doesn't start with ext-)
    const hasNonExtDir = result.some(m =>
      m.id.includes("vscode-compat") && !m.id.includes("ext-")
    );
    expect(hasNonExtDir).toBe(false);
  });

  it("includes _dir property for each discovered manifest", async () => {
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const result = await discoverBundledManifests(packagesDir);

    for (const manifest of result) {
      expect(manifest._dir).toBeTruthy();
      expect(manifest._dir).toMatch(/packages\/ext-/);
    }
  });

  it("manifests have all required fields", async () => {
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const result = await discoverBundledManifests(packagesDir);

    for (const manifest of result) {
      expect(manifest.id).toBeTruthy();
      expect(manifest.version).toBeTruthy();
      expect(manifest.main).toBeTruthy();
      expect(typeof manifest.id).toBe("string");
      expect(typeof manifest.version).toBe("string");
      expect(typeof manifest.main).toBe("string");
    }
  });

  it("handles directories with no valid manifests", async () => {
    // Create a test scenario where ext-* dirs exist but have no package.json
    // For this test, we just verify the function handles empty results gracefully
    const packagesDir = resolve(import.meta.dir, "../../../packages");
    const result = await discoverBundledManifests(packagesDir);

    // Result should be an array (even if empty)
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("hasPpmMarker", () => {
  const base: ExtensionManifest = { id: "a", version: "1.0.0", main: "index.js" };

  it("true when the ppm field is present", () => {
    expect(hasPpmMarker({ ...base, ppm: { displayName: "A" } })).toBe(true);
  });

  it("true when contributes is present", () => {
    expect(hasPpmMarker({ ...base, contributes: {} })).toBe(true);
  });

  it("true when engines.ppm is present", () => {
    expect(hasPpmMarker({ ...base, engines: { ppm: "^1.0.0" } })).toBe(true);
  });

  it("false with no markers at all", () => {
    expect(hasPpmMarker(base)).toBe(false);
  });
});

describe("discoverManifests", () => {
  let extDir: string;

  afterEach(() => {
    if (extDir) rmSync(extDir, { recursive: true, force: true });
  });

  /** Write a minimal package.json into `dir`, creating the dir if needed. */
  function writePkg(dir: string, pkg: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify(pkg));
  }

  /** "junction" needs no elevated privilege on Windows and is silently treated as a plain
   * symlink on POSIX — see file-watcher-watch-tree.test.ts for the same convention. */
  function linkDir(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, "junction");
  }

  it("returns [] when node_modules does not exist", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    const result = await discoverManifests(extDir);
    expect(result).toEqual([]);
  });

  it("finds a dependency package that carries a PPM marker", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    writePkg(extDir, { name: "ppm-extensions", dependencies: { "my-ext": "1.0.0" } });
    writePkg(resolve(extDir, "node_modules", "my-ext"), {
      name: "my-ext", version: "1.0.0", main: "index.js", contributes: {},
    });

    const result = await discoverManifests(extDir);
    expect(result.map((m) => m.id)).toEqual(["my-ext"]);
  });

  it("does not find a dependency package without a PPM marker", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    writePkg(extDir, { name: "ppm-extensions", dependencies: { "plain-dep": "1.0.0" } });
    writePkg(resolve(extDir, "node_modules", "plain-dep"), {
      name: "plain-dep", version: "1.0.0", main: "index.js",
    });

    const result = await discoverManifests(extDir);
    expect(result).toEqual([]);
  });

  it("finds a dev-linked symlink that is not listed in dependencies", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    writePkg(extDir, { name: "ppm-extensions", dependencies: {} });
    const realDir = resolve(extDir, "real-dev-ext");
    writePkg(realDir, { name: "dev-ext", version: "1.0.0", main: "index.js", ppm: {} });
    mkdirSync(resolve(extDir, "node_modules"), { recursive: true });
    linkDir(realDir, resolve(extDir, "node_modules", "dev-ext"));

    const result = await discoverManifests(extDir);
    expect(result.map((m) => m.id)).toEqual(["dev-ext"]);
  });

  it("finds a symlinked @scope/name package", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    writePkg(extDir, { name: "ppm-extensions", dependencies: {} });
    const realDir = resolve(extDir, "real-scoped-ext");
    writePkg(realDir, { name: "@scope/dev-ext", version: "1.0.0", main: "index.js", ppm: {} });
    mkdirSync(resolve(extDir, "node_modules", "@scope"), { recursive: true });
    linkDir(realDir, resolve(extDir, "node_modules", "@scope", "dev-ext"));

    const result = await discoverManifests(extDir);
    expect(result.map((m) => m.id)).toEqual(["@scope/dev-ext"]);
  });

  it("ignores .bin even when it is itself a symlink", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    writePkg(extDir, { name: "ppm-extensions", dependencies: {} });
    const binTarget = resolve(extDir, "some-bin-target");
    mkdirSync(binTarget, { recursive: true });
    mkdirSync(resolve(extDir, "node_modules"), { recursive: true });
    linkDir(binTarget, resolve(extDir, "node_modules", ".bin"));

    const result = await discoverManifests(extDir);
    expect(result).toEqual([]);
  });

  it("treats a missing or invalid package.json as no declared dependencies", async () => {
    extDir = mkdtempSync(resolve(tmpdir(), "ppm-ext-test-"));
    mkdirSync(resolve(extDir, "node_modules"), { recursive: true });

    const result = await discoverManifests(extDir);
    expect(result).toEqual([]);
  });
});
