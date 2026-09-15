import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { branchDiff } from "../../src/services/git-branch-diff/branch-diff.service.ts";

/**
 * The scenario every one of these asserts against: a feature branch, and a base
 * branch that moved on *afterwards*. That is the ordinary state of a branch by
 * the time anyone reviews it, and it is the only state in which two-dot and
 * three-dot differ — so a suite without it passes either way.
 */

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

let repo: string;

async function git(...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-branch-diff-"));
  await git("init", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, "src/keep.ts"), "export const keep = 1;\n");
  writeFileSync(join(repo, "src/rename-me.ts"), "export const moved = 1;\n");
  writeFileSync(join(repo, "src/delete-me.ts"), "export const gone = 1;\n");
  await git("add", ".");
  await git("commit", "-m", "initial");

  // The branch: an add, a modify, a delete, a rename and a binary file, spread
  // over two commits so a single-commit diff could not produce this list.
  await git("checkout", "-b", "feature");
  writeFileSync(join(repo, "src/added.ts"), "export const added = 1;\n");
  writeFileSync(join(repo, "src/keep.ts"), "export const keep = 2;\n");
  await git("rm", "-q", "src/delete-me.ts");
  await git("add", ".");
  await git("commit", "-m", "first half");

  await git("mv", "src/rename-me.ts", "src/renamed.ts");
  writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await git("add", ".");
  await git("commit", "-m", "second half");

  // main moves on afterwards, touching a file the branch never saw.
  await git("checkout", "main");
  writeFileSync(join(repo, "README.md"), "readme\nchanged on main\n");
  await git("add", ".");
  await git("commit", "-m", "main moves ahead");
  await git("checkout", "feature");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("branchDiff", () => {
  it("lists only the branch's own work in three-dot mode", async () => {
    const result = await branchDiff(repo, "main", "feature");
    const paths = result.files.map((f) => f.path);

    expect(paths).toContain("src/added.ts");
    expect(paths).toContain("src/keep.ts");
    expect(paths).toContain("src/delete-me.ts");
    // The base branch's own later commit is not this branch's work.
    expect(paths).not.toContain("README.md");
  });

  it("reports the merge base, not the base ref's tip", async () => {
    const result = await branchDiff(repo, "main", "feature");
    const expected = await git("merge-base", "main", "feature");
    const mainTip = await git("rev-parse", "main");

    expect(result.mergeBase).toBe(expected);
    expect(result.mergeBase).not.toBe(mainTip);
  });

  it("pulls the base ref's own commits in under two-dot mode", async () => {
    const result = await branchDiff(repo, "main", "feature", "two-dot");
    expect(result.files.map((f) => f.path)).toContain("README.md");
    expect(result.mergeBase).toBe("main");
  });

  it("classifies each kind of change", async () => {
    const result = await branchDiff(repo, "main", "feature");
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));

    expect(byPath["src/added.ts"]?.status).toBe("A");
    expect(byPath["src/keep.ts"]?.status).toBe("M");
    expect(byPath["src/delete-me.ts"]?.status).toBe("D");
    expect(byPath["src/renamed.ts"]).toMatchObject({ status: "R", oldPath: "src/rename-me.ts" });
    expect(byPath["logo.png"]?.binary).toBe(true);
  });

  it("gives every file a head-side blob id to remember a review against", async () => {
    const result = await branchDiff(repo, "main", "feature");
    for (const file of result.files) {
      expect(file.blob).toMatch(/^[0-9a-f]{40}$/);
    }
    // A deleted file has no content on the head side, and says so.
    const deleted = result.files.find((f) => f.path === "src/delete-me.ts");
    expect(deleted?.blob).toBe("0".repeat(40));
  });

  it("changes a file's blob only when that file changes", async () => {
    // What makes review progress survive an ongoing branch: committing to one
    // file must not clear the flag on every other.
    const before = await branchDiff(repo, "main", "feature");
    writeFileSync(join(repo, "src/added.ts"), "export const added = 2;\n");
    await git("add", ".");
    await git("commit", "-m", "more work");
    const after = await branchDiff(repo, "main", "feature");

    const blobFor = (r: typeof before, p: string) => r.files.find((f) => f.path === p)?.blob;
    expect(blobFor(after, "src/added.ts")).not.toBe(blobFor(before, "src/added.ts"));
    expect(blobFor(after, "src/keep.ts")).toBe(blobFor(before, "src/keep.ts"));
  });

  it("refuses a ref that would act as an option or a range", async () => {
    await expect(branchDiff(repo, "--output=/tmp/pwned", "feature")).rejects.toThrow(/Invalid git ref/);
    await expect(branchDiff(repo, "main..feature", "feature")).rejects.toThrow(/Invalid git ref/);
  });

  it("resolves head to a commit, so the viewer cannot be opened against a moving ref", async () => {
    // `ref1` was a resolved merge-base while `ref2` was the ref *name*, against
    // this service's own header promising "one resolved commit so the two
    // cannot drift". A commit landing between the list fetch and a file being
    // opened is exactly when that matters.
    const before = await branchDiff(repo, "main", "feature");
    expect(before.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(before.headCommit).toBe(await git("rev-parse", "feature"));

    writeFileSync(join(repo, "src/after-the-fetch.ts"), "export const late = 1;\n");
    await git("add", ".");
    await git("commit", "-m", "lands mid-review");

    // The ref now points somewhere else; the commit the first list described
    // still exists and still describes it.
    expect(await git("rev-parse", "feature")).not.toBe(before.headCommit);
    expect(await git("cat-file", "-t", before.headCommit)).toBe("commit");
  });

  it("caps the file list and says how many it left out", async () => {
    await git("checkout", "-b", "bulk", "main");
    mkdirSync(join(repo, "vendor"), { recursive: true });
    // Stands in for a vendored dependency or a formatter pass: the list is
    // returned in one JSON array and rendered un-virtualized, so the cap is
    // what stops a 20,000-row sidebar and a multi-megabyte response.
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(repo, `vendor/f${i}.ts`), `export const n = ${i};\n`);
    }
    await git("add", ".");
    await git("commit", "-m", "vendor drop");

    const full = await branchDiff(repo, "main", "bulk");
    expect(full.files.length).toBe(40);
    expect(full.omitted).toBe(0);

    const capped = await branchDiff(repo, "main", "bulk", "three-dot", 5);
    expect(capped.files.length).toBe(5);
    expect(capped.omitted).toBe(35);
    // The kept ones are the head of the same list, not an arbitrary subset, so
    // a path is either listed or counted and never both.
    expect(capped.files.map((f) => f.path)).toEqual(full.files.slice(0, 5).map((f) => f.path));

    await git("checkout", "feature");
  });

  it("says so when two refs have no common ancestor", async () => {
    await git("checkout", "--orphan", "unrelated");
    await git("rm", "-rqf", ".");
    writeFileSync(join(repo, "solo.txt"), "alone\n");
    await git("add", ".");
    await git("commit", "-m", "unrelated root");
    await git("checkout", "feature");

    await expect(branchDiff(repo, "unrelated", "feature")).rejects.toThrow(/no common ancestor/);
  });
});
