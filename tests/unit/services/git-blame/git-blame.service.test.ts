/**
 * The blame service against a real repository — the parser is unit-tested
 * separately, so this is about the git invocation and the failure modes the
 * route depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSafeRev, gitBlameService } from "../../../../src/services/git-blame/git-blame.service.ts";
import { isUncommittedHash } from "../../../../src/shared/blame.ts";

let repo: string;

/** Keep the real environment — replacing it drops HOME and git ignores config. */
async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com",
    },
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-blame-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "file.txt"), "alpha\nbeta\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-qm", "first commit"]);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("gitBlameService.blameFile", () => {
  it("attributes every line to its commit", async () => {
    const result = (await gitBlameService.blameFile(repo, "file.txt"))!;

    expect(result.lines.map((l) => l.finalLine)).toEqual([1, 2]);
    const commit = result.commits[result.lines[0]!.hash]!;
    expect(commit.author).toBe("Ada");
    expect(commit.summary).toBe("first commit");
  });

  it("splits a second commit out from the first", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nBETA\n");
    await git(["commit", "-qam", "second commit"]);

    const result = (await gitBlameService.blameFile(repo, "file.txt"))!;

    expect(result.lines[0]!.hash).not.toBe(result.lines[1]!.hash);
    expect(result.commits[result.lines[1]!.hash]!.summary).toBe("second commit");
  });

  it("marks an uncommitted edit rather than blaming the last commit for it", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nbeta\ngamma\n");

    const result = (await gitBlameService.blameFile(repo, "file.txt"))!;

    expect(isUncommittedHash(result.lines[2]!.hash)).toBe(true);
  });

  it("returns null for a file git does not track", async () => {
    writeFileSync(join(repo, "new.txt"), "hello\n");

    expect(await gitBlameService.blameFile(repo, "new.txt")).toBeNull();
  });

  it("refuses a path that escapes the repository", async () => {
    await expect(gitBlameService.blameFile(repo, "../outside.txt"))
      .rejects.toThrow(/escapes the repository/);
  });

  it("refuses a path that could be read as an option", async () => {
    await expect(gitBlameService.blameFile(repo, "--reverse"))
      .rejects.toThrow(/Invalid file path/);
  });
});

/**
 * The diff viewer's left pane is the file at another revision, so blaming the
 * working tree for it would name the wrong commits.
 */
describe("gitBlameService.blameFile at a revision", () => {
  it("names the older commit for a line the newer one replaced", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nBETA\n");
    await git(["commit", "-qam", "second commit"]);

    const atHead = (await gitBlameService.blameFile(repo, "file.txt"))!;
    const atParent = (await gitBlameService.blameFile(repo, "file.txt", "HEAD~1"))!;

    expect(atHead.commits[atHead.lines[1]!.hash]!.summary).toBe("second commit");
    expect(atParent.commits[atParent.lines[1]!.hash]!.summary).toBe("first commit");
  });

  it("does not report uncommitted lines when asked for a revision", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nbeta\ngamma\n");

    const atHead = (await gitBlameService.blameFile(repo, "file.txt", "HEAD"))!;

    // The working tree has three lines; HEAD has two, all of them committed.
    expect(atHead.lines).toHaveLength(2);
    expect(atHead.lines.every((l) => !isUncommittedHash(l.hash))).toBe(true);
  });

  it("returns null for a file that did not exist at that revision", async () => {
    writeFileSync(join(repo, "later.txt"), "hello\n");
    await git(["add", "later.txt"]);
    await git(["commit", "-qm", "add later"]);

    expect(await gitBlameService.blameFile(repo, "later.txt", "HEAD~1")).toBeNull();
  });
});

describe("assertSafeRev", () => {
  it("accepts the revisions the diff viewer passes", () => {
    // `~` and `^` are revision syntax, not an injection risk: the rev is its own
    // argv word, and "diff against the parent" is spelled `HEAD~1`.
    for (const rev of ["HEAD", "HEAD~1", "main^", "main", "origin/main", "refs/heads/main", "v1.2.0", "a".repeat(40)]) {
      expect(assertSafeRev(rev)).toBe(rev);
    }
  });

  it("refuses anything that could be read as an option or a range", () => {
    for (const rev of ["--reverse", "-w", "a..b", "HEAD..main", "HEAD...main", "HEAD:file", ":/search", "a b", ""]) {
      expect(() => assertSafeRev(rev)).toThrow(/Invalid revision/);
    }
  });
});
