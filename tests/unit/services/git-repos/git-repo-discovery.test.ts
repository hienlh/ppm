/**
 * A workspace folder is not always a repository.
 *
 * Pointed at a container — a folder of checkouts, a monorepo of unrelated
 * services — every git surface ran `git` where git knows nothing and reported
 * "not a git repository", which reads as PPM being broken rather than as the
 * repositories being one level down.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverGitRepos,
  isGitRepo,
  DEFAULT_SCAN_DEPTH,
  IGNORED_DIRS,
} from "../../../../src/services/git-repos/git-repo-discovery.ts";

let root: string;

/** A repository is a working tree with a `.git`; a worktree's is a *file*. */
function makeRepo(path: string, kind: "dir" | "file" = "dir"): void {
  mkdirSync(path, { recursive: true });
  if (kind === "dir") mkdirSync(join(path, ".git"));
  else writeFileSync(join(path, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-repos-"));
  makeRepo(join(root, "frontend"));
  makeRepo(join(root, "backend"));
  makeRepo(join(root, "apps", "admin"));            // depth 2
  makeRepo(join(root, "a", "b", "deep"));           // depth 3 — past the cap
  makeRepo(join(root, "linked"), "file");           // a worktree or submodule
  makeRepo(join(root, "frontend", "nested"));       // inside a repo already found
  makeRepo(join(root, "node_modules", "some-dep")); // vendored checkout
  mkdirSync(join(root, "docs", "images"), { recursive: true });
  writeFileSync(join(root, "README.md"), "not a directory\n");
  try {
    symlinkSync(join(root, "frontend"), join(root, "link-to-frontend"));
  } catch {
    // Windows without privileges; the symlink case is simply not covered there.
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverGitRepos", () => {
  it("offers the subfolders that are repositories when the root is not one", () => {
    const found = discoverGitRepos(root);
    expect(found.rootIsRepo).toBe(false);
    expect(found.repos.map((r) => r.relative)).toEqual([
      "backend",
      "frontend",
      "linked",
      "apps/admin",
    ]);
  });

  it("counts a `.git` file, not only a directory", () => {
    // A linked worktree and a submodule both carry `gitdir: …` in a file, and
    // both are repositories you can ask for a history. Testing isDirectory()
    // would skip exactly the layouts most likely to sit inside a container.
    expect(isGitRepo(join(root, "linked"))).toBe(true);
    expect(discoverGitRepos(root).repos.some((r) => r.name === "linked")).toBe(true);
  });

  it("does not look inside a repository it already found", () => {
    // Its submodules are reachable from it; listing them alongside their
    // superproject would offer the same history twice under two names.
    const found = discoverGitRepos(root);
    expect(found.repos.some((r) => r.relative === "frontend/nested")).toBe(false);
  });

  it("stops at the depth cap", () => {
    const found = discoverGitRepos(root);
    expect(DEFAULT_SCAN_DEPTH).toBe(2);
    expect(found.repos.some((r) => r.relative === "a/b/deep")).toBe(false);
    expect(discoverGitRepos(root, { maxDepth: 3 }).repos.some((r) => r.relative === "a/b/deep")).toBe(true);
    // Depth 0 is the root check alone.
    expect(discoverGitRepos(root, { maxDepth: 0 }).repos).toEqual([]);
  });

  it("skips vendored checkouts", () => {
    expect(IGNORED_DIRS.has("node_modules")).toBe(true);
    expect(discoverGitRepos(root).repos.some((r) => r.path.includes("node_modules"))).toBe(false);
    // …unless the caller says otherwise, which is what makes it testable.
    const all = discoverGitRepos(root, { ignore: new Set() });
    expect(all.repos.some((r) => r.relative === "node_modules/some-dep")).toBe(true);
  });

  it("does not follow a symlink into a repository", () => {
    // A link to a parent is a cycle, and a link out of the project would offer
    // a repository the path guard would then refuse to scope to.
    expect(discoverGitRepos(root).repos.some((r) => r.name === "link-to-frontend")).toBe(false);
  });

  it("offers only the root when the root is a repository", () => {
    // The single-repo case must not grow a picker.
    const repo = mkdtempSync(join(tmpdir(), "ppm-repo-"));
    try {
      makeRepo(repo);
      makeRepo(join(repo, "sub"));
      const found = discoverGitRepos(repo);
      expect(found.rootIsRepo).toBe(true);
      expect(found.repos).toHaveLength(1);
      expect(found.repos[0]!.relative).toBe(".");
      expect(found.repos[0]!.path).toBe(found.root);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("answers for a path that does not exist instead of throwing", () => {
    // The project list outlives the directory it points at.
    const found = discoverGitRepos(join(root, "no", "such", "place"));
    expect(found.rootIsRepo).toBe(false);
    expect(found.repos).toEqual([]);
  });
});
