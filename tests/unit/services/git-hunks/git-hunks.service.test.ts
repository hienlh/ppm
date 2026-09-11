/**
 * Hunk staging against a real repository.
 *
 * The unit tests around `buildPatch` prove the arithmetic; only `git apply`
 * itself can prove the patch is one git accepts. These run git for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitHunksService } from "../../../../src/services/git-hunks/git-hunks.service.ts";

let repo: string;

/**
 * Keep the real environment — replacing it drops HOME, which makes git ignore
 * the user's config and silently pick a different default branch.
 */
async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

/**
 * Twenty lines, so that a change at line 2 and one at line 18 stay separate
 * hunks: with the default three lines of context, changes closer than about
 * seven lines apart get merged into one hunk by git.
 */
const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-hunks-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "file.txt"), ORIGINAL);
  await git(["add", "file.txt"]);
  await git(["commit", "-qm", "initial"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Change line 2 and line 18 — far enough apart to stay two hunks. */
function makeTwoDistantChanges(): void {
  const lines = ORIGINAL.split("\n");
  lines[1] = "TWO-changed";
  lines[17] = "EIGHTEEN-changed";
  writeFileSync(join(repo, "file.txt"), lines.join("\n"));
}

describe("gitHunksService.getHunks", () => {
  it("reports one hunk per separated change", async () => {
    makeTwoDistantChanges();

    const result = await gitHunksService.getHunks(repo, "file.txt", "worktree");

    expect(result.hunks).toHaveLength(2);
    expect(result.binary).toBe(false);
  });

  it("reports an untracked file as one hunk of additions", async () => {
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");

    const result = await gitHunksService.getHunks(repo, "new.txt", "worktree");

    // `git add -N` puts it in the index so a normal diff exists at all.
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.lines.every((l) => l.kind === "+")).toBe(true);
  });

  it("refuses a path that escapes the repository", async () => {
    await expect(gitHunksService.getHunks(repo, "../outside.txt", "worktree"))
      .rejects.toThrow(/escapes the repository/);
  });

  it("refuses a path that could be read as an option", async () => {
    await expect(gitHunksService.getHunks(repo, "--output=/tmp/x", "worktree"))
      .rejects.toThrow(/Invalid file path/);
  });
});

describe("gitHunksService.stage", () => {
  it("stages one hunk and leaves the other in the working tree", async () => {
    makeTwoDistantChanges();

    await gitHunksService.stage(repo, "file.txt", [{ hunk: 0 }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("TWO-changed");
    expect(staged).not.toContain("EIGHTEEN-changed");

    const unstaged = await git(["diff"]);
    expect(unstaged).toContain("EIGHTEEN-changed");
    expect(unstaged).not.toContain("TWO-changed");
  });

  it("stages a single line out of a hunk", async () => {
    // Two adjacent changes land in one hunk.
    writeFileSync(join(repo, "file.txt"), ORIGINAL.replace("line-2\n", "TWO-changed\n").replace("line-3\n", "THREE-changed\n"));
    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "worktree");
    expect(hunks).toHaveLength(1);

    const addedIndexes = hunks[0]!.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.kind === "+")
      .map(({ i }) => i);
    const removedIndexes = hunks[0]!.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.kind === "-")
      .map(({ i }) => i);

    // Take the first replacement only: its deletion and its addition.
    await gitHunksService.stage(repo, "file.txt", [{
      hunk: 0,
      lines: [removedIndexes[0]!, addedIndexes[0]!],
    }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("TWO-changed");
    expect(staged).not.toContain("THREE-changed");
  });

  it("stages an untracked file's content", async () => {
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");

    await gitHunksService.stage(repo, "new.txt", [{ hunk: 0 }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("+alpha");
    expect(staged).toContain("+beta");
  });

  it("refuses an empty selection", async () => {
    makeTwoDistantChanges();

    await expect(gitHunksService.stage(repo, "file.txt", []))
      .rejects.toThrow(/No hunks were selected/);
  });

  it("refuses a hunk index that does not exist", async () => {
    makeTwoDistantChanges();

    await expect(gitHunksService.stage(repo, "file.txt", [{ hunk: 9 }]))
      .rejects.toThrow(/No hunk at index 9/);
  });
});

describe("gitHunksService.unstage", () => {
  it("takes one hunk back out of the index and leaves the other staged", async () => {
    makeTwoDistantChanges();
    await git(["add", "file.txt"]);

    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "index");
    expect(hunks).toHaveLength(2);

    await gitHunksService.unstage(repo, "file.txt", [{ hunk: 0 }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).not.toContain("TWO-changed");
    expect(staged).toContain("EIGHTEEN-changed");

    // The file on disk keeps both changes — unstaging is not discarding.
    const onDisk = readFileSync(join(repo, "file.txt"), "utf-8");
    expect(onDisk).toContain("TWO-changed");
    expect(onDisk).toContain("EIGHTEEN-changed");
  });
});

describe("gitHunksService.discard", () => {
  it("throws away one hunk from the working tree and keeps the other", async () => {
    makeTwoDistantChanges();

    await gitHunksService.discard(repo, "file.txt", [{ hunk: 0 }]);

    const onDisk = readFileSync(join(repo, "file.txt"), "utf-8");
    expect(onDisk).toContain("line-2");
    expect(onDisk).not.toContain("TWO-changed");
    expect(onDisk).toContain("EIGHTEEN-changed");
  });
});

describe("round trip", () => {
  it("stage then unstage the same hunk returns to the starting point", async () => {
    makeTwoDistantChanges();
    const before = await git(["diff"]);

    await gitHunksService.stage(repo, "file.txt", [{ hunk: 0 }]);
    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "index");
    await gitHunksService.unstage(repo, "file.txt", [{ hunk: 0 }]);

    expect(hunks).toHaveLength(1);
    expect(await git(["diff", "--cached"])).toBe("");
    expect(await git(["diff"])).toBe(before);
  });

  it("staging every hunk one at a time matches staging the whole file", async () => {
    makeTwoDistantChanges();

    await gitHunksService.stage(repo, "file.txt", [{ hunk: 0 }, { hunk: 1 }]);

    expect(await git(["diff"])).toBe("");
    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("TWO-changed");
    expect(staged).toContain("EIGHTEEN-changed");
  });

  it("keeps a file that has no trailing newline intact", async () => {
    writeFileSync(join(repo, "nonl.txt"), "alpha\nbeta");
    await git(["add", "nonl.txt"]);
    await git(["commit", "-qm", "no trailing newline"]);
    writeFileSync(join(repo, "nonl.txt"), "alpha\nBETA");

    await gitHunksService.stage(repo, "nonl.txt", [{ hunk: 0 }]);

    expect(await git(["diff"])).toBe("");
    expect(await git(["diff", "--cached"])).toContain("\\ No newline at end of file");
  });
});
