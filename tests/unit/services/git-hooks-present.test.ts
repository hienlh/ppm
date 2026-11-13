/**
 * Which of a repository's own git hooks an operation will run, read from real repositories: the
 * default hooks folder (where `.sample` files never count), a `core.hooksPath` such as Husky's
 * tracked `.husky`, Husky 9's `.husky/_` stubs (which run `.husky/<name>` only when it exists),
 * and a hooks folder outside the repository.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveHooksDir, gitHooksPresent, hooksIn } from "../../../src/services/git-workflow/git-hooks-present.ts";

const MERGE_HOOKS = ["pre-commit", "pre-merge-commit", "commit-msg", "post-merge", "reference-transaction"];
const roots: string[] = [];
let repo = "";

const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
};
const hook = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ppm-hooks-present-"));
  roots.push(repo);
  git("init", "-q");
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("gitHooksPresent", () => {
  it("finds no hook in a fresh repository, whose hooks folder holds only samples", async () => {
    hook(join(repo, ".git/hooks/pre-commit.sample"));
    expect(await gitHooksPresent(repo, MERGE_HOOKS)).toEqual({ hooks: [], where: ".git/hooks" });
  });

  it("lists the default folder's hooks in the order asked, ignoring the ones not asked about", async () => {
    hook(join(repo, ".git/hooks/post-merge"));
    hook(join(repo, ".git/hooks/pre-commit"));
    hook(join(repo, ".git/hooks/pre-push"));
    expect(await gitHooksPresent(repo, MERGE_HOOKS)).toEqual({ hooks: ["pre-commit", "post-merge"], where: ".git/hooks" });
  });

  it("follows core.hooksPath to a tracked .husky folder, and no longer reads .git/hooks", async () => {
    hook(join(repo, ".git/hooks/commit-msg"));
    hook(join(repo, ".husky/post-merge"));
    hook(join(repo, ".husky/pre-commit"));
    git("config", "core.hooksPath", ".husky");
    expect(await gitHooksPresent(repo, MERGE_HOOKS)).toEqual({ hooks: ["pre-commit", "post-merge"], where: ".husky" });
  });

  it("reads Husky 9's stubs through to the hooks they would run", async () => {
    // `.husky/_` holds a stub for every name plus the `h` runner; only `.husky/pre-commit` is real.
    for (const name of ["h", ...MERGE_HOOKS]) hook(join(repo, ".husky/_", name));
    hook(join(repo, ".husky/pre-commit"));
    git("config", "core.hooksPath", ".husky/_");
    expect(await gitHooksPresent(repo, MERGE_HOOKS)).toEqual({ hooks: ["pre-commit"], where: ".husky" });
    expect(effectiveHooksDir(join(repo, ".husky/_"))).toBe(join(repo, ".husky"));
  });

  it("names a hooks folder outside the repository by its absolute path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ppm-hooks-outside-"));
    roots.push(outside);
    hook(join(outside, "post-merge"));
    git("config", "core.hooksPath", outside);
    const found = await gitHooksPresent(repo, MERGE_HOOKS);
    expect(found?.hooks).toEqual(["post-merge"]);
    expect(found?.where).toBe(outside);
  });

  it("answers null outside a repository, and hooksIn ignores folders named like a hook", async () => {
    const plain = mkdtempSync(join(tmpdir(), "ppm-hooks-none-"));
    roots.push(plain);
    expect(await gitHooksPresent(join(plain, "missing"), MERGE_HOOKS)).toBeNull();
    mkdirSync(join(plain, "post-merge"));
    expect(hooksIn(plain, MERGE_HOOKS)).toEqual([]);
  });
});
