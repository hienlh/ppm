/**
 * The working tree as `/git/changes` reports it, against real repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangesService } from "../../../../src/services/git-changes/git-changes.service.ts";
import { gitHunksService } from "../../../../src/services/git-hunks/git-hunks.service.ts";
import type { ChangedFile, GitChanges } from "../../../../src/shared/git-changes.ts";

let root: string;
let repo: string;

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
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag}-${i + 1}`).join("\n") + "\n";
const write = (path: string, content: string | Buffer) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const file = (changes: GitChanges, path: string): ChangedFile => {
  const found = changes.files.find((f) => f.path === path);
  if (!found) throw new Error(`${path} not listed: ${changes.files.map((f) => f.path).join(", ")}`);
  return found;
};

/** Every block id must be the one the hunk routes would resolve. */
async function expectIdsMatchHunkRoutes(changes: GitChanges): Promise<void> {
  for (const f of changes.files) {
    for (const [side, scope] of [["staged", "index"], ["unstaged", "worktree"]] as const) {
      const s = f[side];
      if (!s || s.whole) continue;
      const listed = await gitHunksService.getHunks(repo, f.path, scope);
      expect({ path: f.path, side, ids: s.blocks.map((b) => b.id) })
        .toEqual({ path: f.path, side, ids: listed.hunks.map((h) => h.id) });
    }
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ppm-changes-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  await git(["init", "-q", "-b", "main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getChanges", () => {
  beforeEach(async () => {
    write("two-hunks.txt", lines(30));
    write("both.txt", lines(30));
    write("staged.txt", lines(10));
    write("gone.txt", lines(5));
    write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    write("run.sh", "echo hi\n");
    write("old name.ts", lines(8, "body"));
    write("tiếng việt.md", lines(4));
    write("a.txt", lines(4));
    write("empty.txt", "");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "initial"]);

    write("two-hunks.txt", lines(30).replace("line-2\n", "LINE-2\n").replace("line-28\n", "LINE-28\n"));
    write("both.txt", lines(30).replace("line-2\n", "STAGED-2\n"));
    await git(["add", "both.txt"]);
    write("both.txt", lines(30).replace("line-2\n", "STAGED-2\n").replace("line-25\n", "LATER-25\n"));
    write("staged.txt", lines(10).replace("line-5\n", "LINE-5\n"));
    await git(["add", "staged.txt"]);
    unlinkSync(join(repo, "gone.txt"));
    write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    // In the index rather than on disk: Git for Windows has `core.filemode=false`, so a chmod there changes nothing git sees.
    await git(["update-index", "--chmod=+x", "run.sh"]);
    await git(["mv", "old name.ts", "new name.ts"]);
    write("tiếng việt.md", lines(4).replace("line-1\n", "dòng-1\n"));
    write("new file.ts", "export const x = 1;\nexport const y = 2;\n");
    write("[ab].txt", "glob-looking\n");
    write("empty.txt", "now has text\n");
  });

  it("lists every file with its blocks per side", async () => {
    const changes = await gitChangesService.getChanges(repo);

    const twoHunks = file(changes, "two-hunks.txt");
    expect([twoHunks.x, twoHunks.y]).toEqual([".", "M"]);
    expect(twoHunks.staged).toBeNull();
    expect(twoHunks.unstaged!.blocks).toHaveLength(2);
    expect(twoHunks.unstaged!.blocks.map((b) => [b.added, b.removed])).toEqual([[1, 1], [1, 1]]);

    const both = file(changes, "both.txt");
    expect(both.staged!.blocks).toHaveLength(1);
    expect(both.unstaged!.blocks).toHaveLength(1);

    expect(file(changes, "gone.txt").unstaged).toMatchObject({ removed: 5, added: 0 });
    expect(file(changes, "logo.png").unstaged!.whole).toBe("binary");
    expect(file(changes, "run.sh").staged!.whole).toBe("mode");

    const renamed = file(changes, "new name.ts");
    expect(renamed.oldPath).toBe("old name.ts");
    expect(renamed.x).toBe("R");
    expect(renamed.staged).toMatchObject({ whole: "rename", added: 0, removed: 0 });
    expect(changes.files.some((f) => f.path === "old name.ts")).toBe(false);

    expect(file(changes, "tiếng việt.md").unstaged!.blocks).toHaveLength(1);

    const untracked = file(changes, "new file.ts");
    expect(untracked.untracked).toBe(true);
    expect(untracked.unstaged).toMatchObject({ added: 2, removed: 0 });
    expect(untracked.unstaged!.blocks).toHaveLength(1);

    // A glob-looking name is one file, not a pattern that also reads a.txt.
    expect(file(changes, "[ab].txt").unstaged!.blocks).toHaveLength(1);
    expect(changes.files.some((f) => f.path === "a.txt")).toBe(false);

    expect(file(changes, "empty.txt").unstaged!.blocks).toHaveLength(1);
  });

  it("gives every block the id the hunk routes resolve", async () => {
    await expectIdsMatchHunkRoutes(await gitChangesService.getChanges(repo));
  });

  it("never writes the user's index", async () => {
    const before = await git(["status", "--porcelain=v1"]);
    await gitChangesService.getChanges(repo);
    expect(await git(["status", "--porcelain=v1"])).toBe(before);
    expect(before).toContain("?? \"new file.ts\"");
  });

  it("is not thrown off by diff settings in the user's config", async () => {
    await git(["config", "diff.noprefix", "true"]);
    await git(["config", "diff.mnemonicPrefix", "true"]);
    await git(["config", "color.ui", "always"]);
    await git(["config", "core.quotePath", "false"]);
    const changes = await gitChangesService.getChanges(repo);
    expect(file(changes, "two-hunks.txt").unstaged!.blocks).toHaveLength(2);
    expect(file(changes, "tiếng việt.md").unstaged!.blocks).toHaveLength(1);
    await expectIdsMatchHunkRoutes(changes);
  });

  it("offers a file too big to send as blocks whole", async () => {
    write("big.txt", lines(60_000, "generated"));
    const big = file(await gitChangesService.getChanges(repo), "big.txt");
    expect(big.unstaged!.whole).toBe("large");
    expect(big.unstaged!.added).toBe(60_000);
  });

  // A file symlink needs Developer Mode on Windows.
  it.skipIf(process.platform === "win32")("reads a symlink replaced by a file as a type change", async () => {
    symlinkSync("a.txt", join(repo, "link"));
    await git(["add", "link"]);
    await git(["commit", "-qm", "link"]);
    unlinkSync(join(repo, "link"));
    write("link", "a file now\n");
    const link = file(await gitChangesService.getChanges(repo), "link");
    expect(link.y).toBe("T");
    expect(link.unstaged!.whole).toBe("type");
  });
});

describe("branch and history", () => {
  it("reports an unborn branch with its files", async () => {
    write("first.txt", "hello\n");
    const changes = await gitChangesService.getChanges(repo);
    expect(changes.branch).toMatchObject({ head: "main", oid: null, upstream: null, upstreamGone: false, hasRemote: false });
    expect(changes.lastCommit).toBeNull();
    expect(file(changes, "first.txt").untracked).toBe(true);
  });

  it("reports upstream, ahead and behind, and whether HEAD was pushed", async () => {
    const remote = join(root, "remote.git");
    await git(["init", "-q", "--bare", "-b", "main", remote], root);
    write("a.txt", "a\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "one"]);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "-u", "origin", "main"]);

    let changes = await gitChangesService.getChanges(repo);
    expect(changes.branch).toMatchObject({ head: "main", upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0, hasRemote: true });
    expect(changes.lastCommit).toMatchObject({ subject: "one", pushed: true, hasParent: false });

    write("a.txt", "a\nb\n");
    await git(["commit", "-qam", "two"]);
    gitChangesService.invalidate(repo);
    changes = await gitChangesService.getChanges(repo);
    expect(changes.branch.ahead).toBe(1);
    expect(changes.lastCommit).toMatchObject({ subject: "two", pushed: false, hasParent: true });
  });

  it("tells an upstream deleted from the remote apart from one that is level", async () => {
    const remote = join(root, "remote.git");
    await git(["init", "-q", "--bare", "-b", "main", remote], root);
    write("a.txt", "a\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "one"]);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "-u", "origin", "main:gone"]);
    await git(["branch", "-q", "--set-upstream-to=origin/gone"]);
    await git(["push", "-q", "origin", "--delete", "gone"]);
    const changes = await gitChangesService.getChanges(repo);
    expect(changes.branch).toMatchObject({ upstream: "origin/gone", upstreamGone: true, ahead: 0, behind: 0 });
  });

  it("treats a branch with no upstream as pushed only if a remote branch has it", async () => {
    const remote = join(root, "remote.git");
    await git(["init", "-q", "--bare", "-b", "main", remote], root);
    write("a.txt", "a\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "one"]);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "origin", "main"]);
    await git(["fetch", "-q", "origin"]);
    await git(["checkout", "-q", "-b", "topic"]);
    expect((await gitChangesService.getChanges(repo)).lastCommit!.pushed).toBe(true);
    write("a.txt", "a\nb\n");
    await git(["commit", "-qam", "local only"]);
    gitChangesService.invalidate(repo);
    expect((await gitChangesService.getChanges(repo)).lastCommit!.pushed).toBe(false);
  });

  it("reports a detached HEAD", async () => {
    write("a.txt", "a\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "one"]);
    await git(["checkout", "-q", "--detach"]);
    const changes = await gitChangesService.getChanges(repo);
    expect(changes.branch.head).toBeNull();
    expect(changes.branch.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("counts stashes", async () => {
    write("a.txt", "a\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "one"]);
    write("a.txt", "b\n");
    await git(["stash", "-q"]);
    write("a.txt", "c\n");
    await git(["stash", "-q"]);
    expect((await gitChangesService.getChanges(repo)).stashes).toBe(2);
  });
});

describe("a merge that stopped on a conflict", () => {
  beforeEach(async () => {
    write("c.txt", "base\n");
    write("clean.txt", lines(10));
    await git(["add", "-A"]);
    await git(["commit", "-qm", "base"]);
    await git(["checkout", "-q", "-b", "feature"]);
    write("c.txt", "feature\n");
    await git(["commit", "-qam", "feature side"]);
    await git(["checkout", "-q", "main"]);
    write("c.txt", "main\n");
    write("clean.txt", lines(10).replace("line-1\n", "MAIN-1\n"));
    await git(["commit", "-qam", "main side"]);
    await git(["checkout", "-q", "feature"]);
    await git(["merge", "main"]).catch(() => undefined);
  });

  it("names the merge and lists the conflict without blocks", async () => {
    const changes = await gitChangesService.getChanges(repo);
    expect(changes.operation).toMatchObject({ kind: "merge", name: "main" });
    expect(changes.operation!.head).toMatch(/^[0-9a-f]{7}$/);
    const conflict = file(changes, "c.txt");
    expect(conflict).toMatchObject({ conflict: true, staged: null, unstaged: null });
    // What merged cleanly is already staged.
    expect(file(changes, "clean.txt").staged!.blocks).toHaveLength(1);
  });

  it("clears once the merge is aborted", async () => {
    await git(["merge", "--abort"]);
    gitChangesService.invalidate(repo);
    const changes = await gitChangesService.getChanges(repo);
    expect(changes.operation).toBeNull();
    expect(changes.files).toHaveLength(0);
  });
});

describe("getFileChanges", () => {
  beforeEach(async () => {
    write("both.txt", lines(30));
    write("old.ts", lines(12, "keep"));
    await git(["add", "-A"]);
    await git(["commit", "-qm", "initial"]);
    write("both.txt", lines(30).replace("line-2\n", "STAGED-2\n"));
    await git(["add", "both.txt"]);
    write("both.txt", lines(30).replace("line-2\n", "STAGED-2\n").replace("line-25\n", "LATER-25\n"));
    await git(["mv", "old.ts", "new.ts"]);
    write("fresh.md", "# Fresh\n");
  });

  it("returns both sides with their lines and the same ids as the summary", async () => {
    const detail = await gitChangesService.getFileChanges(repo, "both.txt");
    const summary = file(await gitChangesService.getChanges(repo), "both.txt");
    expect(detail.staged!.hunks.map((h) => h.id)).toEqual(summary.staged!.blocks.map((b) => b.id));
    expect(detail.unstaged!.hunks.map((h) => h.id)).toEqual(summary.unstaged!.blocks.map((b) => b.id));
    expect(detail.staged!.hunks[0]!.lines.filter((l) => l.kind !== " ").map((l) => l.kind + l.text))
      .toEqual(["-line-2", "+STAGED-2"]);
  });

  it("shows a staged rename as git would, but whole", async () => {
    const detail = await gitChangesService.getFileChanges(repo, "new.ts", "old.ts");
    expect(detail).toMatchObject({ x: "R", oldPath: "old.ts" });
    expect(detail.staged).toMatchObject({ whole: "rename", added: 0, removed: 0 });
  });

  it("reads an untracked file without adding it to the index", async () => {
    const detail = await gitChangesService.getFileChanges(repo, "fresh.md");
    expect(detail.untracked).toBe(true);
    expect(detail.unstaged!.hunks[0]!.lines).toEqual([{ kind: "+", text: "# Fresh" }]);
    expect(await git(["status", "--porcelain=v1", "--", "fresh.md"])).toBe("?? fresh.md\n");
  });

  it("answers an unchanged file with no sides", async () => {
    write("same.txt", "x\n");
    await git(["add", "same.txt"]);
    await git(["commit", "-qm", "same"]);
    expect(await gitChangesService.getFileChanges(repo, "same.txt"))
      .toMatchObject({ x: ".", y: ".", staged: null, unstaged: null });
  });

  it("refuses a path outside the repository", async () => {
    await expect(gitChangesService.getFileChanges(repo, "../etc/passwd")).rejects.toThrow(/escapes/);
    await expect(gitChangesService.getFileChanges(repo, "--output=x")).rejects.toThrow(/Invalid/);
  });
});

describe("sharing one computation", () => {
  it("joins a running read, but not one that started before a write", async () => {
    write("a.txt", "a\n");
    const first = gitChangesService.getChanges(repo);
    expect(gitChangesService.getChanges(repo)).toBe(first);
    gitChangesService.invalidate(repo);
    const after = gitChangesService.getChanges(repo);
    expect(after).not.toBe(first);
    await Promise.all([first, after]);
  });
});
