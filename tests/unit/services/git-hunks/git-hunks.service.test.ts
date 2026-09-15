/**
 * Hunk staging against a real repository.
 *
 * The unit tests around `buildPatch` prove the arithmetic; only `git apply`
 * itself can prove the patch is one git accepts. These run git for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gitHunksService } from "../../../../src/services/git-hunks/git-hunks.service.ts";
import type { HunkRequest, HunkScope } from "../../../../src/services/git-hunks/git-hunks.service.ts";

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
  writeFileSync(join(repo, "file.txt"), withChanges({ 2: "TWO-changed", 18: "EIGHTEEN-changed" }));
}

/** `ORIGINAL` with the named 1-based lines replaced. */
function withChanges(changes: Record<number, string>): string {
  const lines = ORIGINAL.split("\n");
  for (const [number, text] of Object.entries(changes)) lines[Number(number) - 1] = text;
  return lines.join("\n");
}

/**
 * What the browser sends back: the hunk's position *and* the content address it
 * was listed with. Every call has to go through the list first, which is the
 * point — a selection that was never listed cannot be applied.
 */
async function pick(
  filePath: string,
  scope: HunkScope,
  indexes: number[],
): Promise<HunkRequest[]> {
  const { hunks } = await gitHunksService.getHunks(repo, filePath, scope);
  return indexes.map((i) => {
    const hunk = hunks[i];
    if (!hunk) throw new Error(`no hunk ${i} to pick — the file has ${hunks.length}`);
    return { hunk: i, id: hunk.id };
  });
}

/** The staged bytes of a path, read without going through any decoder. */
async function stagedBytes(filePath: string): Promise<Buffer> {
  const proc = Bun.spawn(["git", "show", `:${filePath}`], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  if (await proc.exited !== 0) throw new Error(`git show :${filePath} failed: ${err}`);
  return Buffer.from(out);
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

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

    // A `git add -N` on a throwaway index is what gives it something to diff
    // against; the user's own index is not touched to answer a question.
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]!.lines.every((l) => l.kind === "+")).toBe(true);
    expect(await git(["status", "--porcelain"])).toBe("?? new.txt\n");
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

    await gitHunksService.stage(repo, "file.txt", await pick("file.txt", "worktree", [0]));

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
      id: hunks[0]!.id,
      lines: [removedIndexes[0]!, addedIndexes[0]!],
    }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("TWO-changed");
    expect(staged).not.toContain("THREE-changed");
  });

  it("stages an untracked file's content", async () => {
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");

    await gitHunksService.stage(repo, "new.txt", await pick("new.txt", "worktree", [0]));

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("+alpha");
    expect(staged).toContain("+beta");
  });

  it("refuses an empty selection", async () => {
    makeTwoDistantChanges();

    await expect(gitHunksService.stage(repo, "file.txt", []))
      .rejects.toThrow(/No hunks were selected/);
  });

  it("goes by the hunk's content, not the index the client sent", async () => {
    makeTwoDistantChanges();
    const [second] = await pick("file.txt", "worktree", [1]);

    // The index is a hint for telling two identical hunks apart; on its own it
    // decides nothing, so a wrong one still stages the hunk that was ticked.
    await gitHunksService.stage(repo, "file.txt", [{ ...second!, hunk: 9 }]);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("EIGHTEEN-changed");
    expect(staged).not.toContain("TWO-changed");
  });
});

describe("gitHunksService.unstage", () => {
  it("takes one hunk back out of the index and leaves the other staged", async () => {
    makeTwoDistantChanges();
    await git(["add", "file.txt"]);

    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "index");
    expect(hunks).toHaveLength(2);

    await gitHunksService.unstage(repo, "file.txt", [{ hunk: 0, id: hunks[0]!.id }]);

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

    await gitHunksService.discard(repo, "file.txt", await pick("file.txt", "worktree", [0]));

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

    await gitHunksService.stage(repo, "file.txt", await pick("file.txt", "worktree", [0]));
    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "index");
    await gitHunksService.unstage(repo, "file.txt", [{ hunk: 0, id: hunks[0]!.id }]);

    expect(hunks).toHaveLength(1);
    expect(await git(["diff", "--cached"])).toBe("");
    expect(await git(["diff"])).toBe(before);
  });

  it("staging every hunk one at a time matches staging the whole file", async () => {
    makeTwoDistantChanges();

    await gitHunksService.stage(repo, "file.txt", await pick("file.txt", "worktree", [0, 1]));

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

    await gitHunksService.stage(repo, "nonl.txt", await pick("nonl.txt", "worktree", [0]));

    expect(await git(["diff"])).toBe("");
    expect(await git(["diff", "--cached"])).toContain("\\ No newline at end of file");
  });
});

describe("a file that moved on after the hunks were listed", () => {
  it("refuses to stage a hunk the file no longer has", async () => {
    makeTwoDistantChanges();
    const stale = await pick("file.txt", "worktree", [0]);

    // The user keeps typing while the dialog is open: line 2 says something
    // else now, so hunk 0 of *this* diff is not the hunk that was ticked.
    writeFileSync(join(repo, "file.txt"), withChanges({ 2: "TWO-something-else", 18: "EIGHTEEN-changed" }));

    await expect(gitHunksService.stage(repo, "file.txt", stale))
      .rejects.toThrow(/changed since these hunks were listed/);
    expect(await git(["diff", "--cached"])).toBe("");
  });

  it("refuses to discard a hunk the file no longer has", async () => {
    // The unrecoverable one: discarding by a stale index throws away whatever
    // now sits at that position, and there is nothing to recover it from.
    makeTwoDistantChanges();
    const stale = await pick("file.txt", "worktree", [0]);

    const edited = withChanges({ 2: "TWO-something-else", 18: "EIGHTEEN-changed" });
    writeFileSync(join(repo, "file.txt"), edited);

    await expect(gitHunksService.discard(repo, "file.txt", stale))
      .rejects.toThrow(/changed since these hunks were listed/);
    expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(edited);
  });

  it("refuses to discard the surviving twin of an identical change", async () => {
    // The wiring test for `refuseMoved`, not the arithmetic — that lives in
    // unified-diff.test.ts. What this pins is that `discard` is the caller that
    // asks for it, because the unit test passes happily if it stops.
    //
    // Two identical blocks under the same heading produce two hunks with the
    // same fingerprint, so only the index tells them apart. Revert one copy by
    // hand and the request still matches the *other* — which discard would throw
    // away with nothing to recover it from.
    const block = ["p", "q", "r", "beta", "s", "t", "u"];
    // Indented, so git's funcname pattern skips these and both hunks take the
    // same "def f():" heading; the heading is part of the fingerprint.
    const gap = Array.from({ length: 10 }, (_, i) => `    filler-${i + 1}`);
    const build = (first: string, second: string) => [
      "def f():", ...block.map((l) => (l === "beta" ? first : l)),
      ...gap,
      "def f():", ...block.map((l) => (l === "beta" ? second : l)),
    ].join("\n") + "\n";

    writeFileSync(join(repo, "file.txt"), build("beta", "beta"));
    await git(["add", "file.txt"]);
    await git(["commit", "-qm", "twins"]);

    writeFileSync(join(repo, "file.txt"), build("BETA", "BETA"));
    const listed = await gitHunksService.getHunks(repo, "file.txt", "worktree");
    expect(listed.hunks).toHaveLength(2);
    expect(listed.hunks[0]!.id).toBe(listed.hunks[1]!.id);
    const second = [{ hunk: 1, id: listed.hunks[1]!.id }];

    // The user puts the second copy back; only the first edit is left, and it
    // answers to the fingerprint the request carries.
    const edited = build("BETA", "beta");
    writeFileSync(join(repo, "file.txt"), edited);

    await expect(gitHunksService.discard(repo, "file.txt", second))
      .rejects.toThrow(/moved in the file since it was listed/);
    expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(edited);
  });

  it("still stages a hunk that only moved down the list", async () => {
    // The counterpart: staging can be undone, so following a hunk that shifted
    // is a convenience worth keeping. This is what a blanket refusal would cost.
    makeTwoDistantChanges();
    const second = await pick("file.txt", "worktree", [1]);

    // Drop the earlier change, so the ticked hunk is now index 0 rather than 1.
    writeFileSync(join(repo, "file.txt"), withChanges({ 18: "EIGHTEEN-changed" }));

    await gitHunksService.stage(repo, "file.txt", second);
    expect(await git(["diff", "--cached"])).toContain("EIGHTEEN-changed");
  });

  it("refuses a selection from a client too old to send an id", async () => {
    makeTwoDistantChanges();

    await expect(gitHunksService.stage(repo, "file.txt", [{ hunk: 0 } as unknown as HunkRequest]))
      .rejects.toThrow(/older client/);
    expect(await git(["diff", "--cached"])).toBe("");
  });

  it("still stages the right hunk when an unrelated edit moved it down the list", async () => {
    makeTwoDistantChanges();
    const stale = await pick("file.txt", "worktree", [1]);

    // A third change lands between the two, so the ticked hunk is now index 2.
    writeFileSync(join(repo, "file.txt"), withChanges({
      2: "TWO-changed", 10: "TEN-changed", 18: "EIGHTEEN-changed",
    }));
    expect((await gitHunksService.getHunks(repo, "file.txt", "worktree")).hunks).toHaveLength(3);

    await gitHunksService.stage(repo, "file.txt", stale);

    const staged = await git(["diff", "--cached"]);
    expect(staged).toContain("EIGHTEEN-changed");
    expect(staged).not.toContain("TWO-changed");
    expect(staged).not.toContain("TEN-changed");
  });
});

describe("byte fidelity", () => {
  /**
   * git's output arrives in 64 KB chunks, so a diff has to be comfortably
   * larger than that before a multi-byte character can straddle a boundary —
   * and the characters have to be everywhere in it, since a boundary falling
   * between two ASCII bytes proves nothing. Decoding chunk by chunk turns the
   * split character into two U+FFFD, and a patch carrying those no longer
   * matches the file.
   */
  it("keeps a diff far larger than one pipe chunk intact", async () => {
    const line = (i: number) => `行${i}：日本語のテキストと絵文字 🍣 と記号 — ${i}`;
    const before = Array.from({ length: 4000 }, (_, i) => line(i)).join("\n") + "\n";
    writeFileSync(join(repo, "big.txt"), before);
    await git(["add", "big.txt"]);
    await git(["commit", "-qm", "big"]);

    // Two blocks of changes with 1000 untouched lines between them, so they
    // stay two hunks and each one is hundreds of kilobytes of diff.
    const changed = (i: number) => (i < 2000 || i >= 3000 ? `${line(i)}／変更` : line(i));
    const after = Array.from({ length: 4000 }, (_, i) => changed(i)).join("\n") + "\n";
    writeFileSync(join(repo, "big.txt"), after);

    const { hunks } = await gitHunksService.getHunks(repo, "big.txt", "worktree");
    expect(hunks).toHaveLength(2);
    expect(hunks.some((h) => h.lines.some((l) => l.text.includes("�")))).toBe(false);

    await gitHunksService.stage(repo, "big.txt", [{ hunk: 0, id: hunks[0]!.id }]);

    // Only the first block is staged, and byte for byte rather than nearly.
    const expected = Array.from({ length: 4000 }, (_, i) => (i < 2000 ? changed(i) : line(i))).join("\n") + "\n";
    expect(sha(await stagedBytes("big.txt"))).toBe(sha(Buffer.from(expected, "utf-8")));
    expect(sha(readFileSync(join(repo, "big.txt")))).toBe(sha(Buffer.from(after, "utf-8")));
  });

  it("stages a file that is not UTF-8 at all", async () => {
    // ISO-8859-1: 0xED is "í" and is not valid UTF-8 on its own, so any decode
    // that is not a byte round-trip replaces it and the patch stops matching.
    const latin1 = (text: string) => Buffer.from(text, "latin1");
    const spanish = (changes: Record<number, string>) => latin1(
      Array.from({ length: 20 }, (_, i) => changes[i + 1] ?? `l\xedne\xe1-${i + 1}`).join("\n") + "\n",
    );

    writeFileSync(join(repo, "es.txt"), spanish({}));
    await git(["add", "es.txt"]);
    await git(["commit", "-qm", "latin-1"]);

    const after = spanish({ 2: "DOS-cambi\xf3", 18: "DIECIOCHO-cambi\xf3" });
    writeFileSync(join(repo, "es.txt"), after);

    const { hunks } = await gitHunksService.getHunks(repo, "es.txt", "worktree");
    expect(hunks).toHaveLength(2);

    await gitHunksService.stage(repo, "es.txt", [{ hunk: 0, id: hunks[0]!.id }]);

    expect(sha(await stagedBytes("es.txt"))).toBe(sha(spanish({ 2: "DOS-cambi\xf3" })));
    expect(sha(readFileSync(join(repo, "es.txt")))).toBe(sha(after));
  });
});

describe("renames", () => {
  /**
   * `git apply --cached --reverse` on a rename patch rewrites index *entries*
   * rather than lines: it takes the new path out of the index altogether and
   * leaves the old one staged as deleted, one commit away from losing the
   * file's history. `--no-renames` is what keeps such a patch from ever being
   * built, and this is the shortest way to check the flag is still there —
   * git only pairs a deletion with an addition when both sides are inside the
   * pathspec, which a single file path never is.
   */
  it("describes a staged git mv as content, never as a rename", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "a.txt"), ORIGINAL);
    await git(["add", "sub/a.txt"]);
    await git(["commit", "-qm", "sub"]);

    await git(["mv", "sub/a.txt", "sub/b.txt"]);
    writeFileSync(join(repo, "sub", "b.txt"), withChanges({ 2: "TWO-changed" }));
    await git(["add", "-A", "sub"]);
    expect(await git(["status", "--porcelain"])).toContain("R  sub/a.txt -> sub/b.txt");

    const { hunks } = await gitHunksService.getHunks(repo, "sub", "index");

    // Rename detection answers with a single 92%-similar patch whose only
    // removed line is the one that changed. The content form removes the whole
    // of the old path and adds the whole of the new one.
    expect(hunks.length).toBe(2);
    const removed = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "-").map((l) => l.text);
    expect(removed).toContain("line-1");
    expect(removed).toContain("line-20");
  });
});

describe("a file git has never seen", () => {
  beforeEach(() => {
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\ngamma\n");
  });

  it("leaves the index exactly as it found it", async () => {
    const before = await git(["ls-files", "--stage"]);

    await gitHunksService.getHunks(repo, "new.txt", "worktree");

    // Listing hunks is a GET. Recording the intent to add in the real index
    // would turn `?? new.txt` into `A new.txt` on nothing more than opening a
    // dialog, and would survive closing it again.
    expect(await git(["ls-files", "--stage"])).toBe(before);
    expect(await git(["status", "--porcelain"])).toBe("?? new.txt\n");
  });

  it("stages it without an intent-to-add entry being there first", async () => {
    await gitHunksService.stage(repo, "new.txt", await pick("new.txt", "worktree", [0]));

    expect(await git(["status", "--porcelain"])).toBe("A  new.txt\n");
    expect(sha(await stagedBytes("new.txt"))).toBe(sha(Buffer.from("alpha\nbeta\ngamma\n", "utf-8")));
  });

  it("stages part of it and leaves the rest in the working tree", async () => {
    const { hunks } = await gitHunksService.getHunks(repo, "new.txt", "worktree");

    await gitHunksService.stage(repo, "new.txt", [{ hunk: 0, id: hunks[0]!.id, lines: [0] }]);

    expect(sha(await stagedBytes("new.txt"))).toBe(sha(Buffer.from("alpha\n", "utf-8")));
    expect(readFileSync(join(repo, "new.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("takes the file with it when every line is discarded, and stages nothing", async () => {
    // Discarding all of an untracked file is deleting it — that is what the
    // dialog's second click says. What must not survive is a staged deletion of
    // a file that was never in a commit, which is what the listing's own
    // `git add -N` used to leave behind.
    await gitHunksService.discard(repo, "new.txt", await pick("new.txt", "worktree", [0]));

    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(await git(["status", "--porcelain"])).toBe("");
  });

  it("keeps the file when only some of its lines are discarded", async () => {
    const { hunks } = await gitHunksService.getHunks(repo, "new.txt", "worktree");

    await gitHunksService.discard(repo, "new.txt", [{ hunk: 0, id: hunks[0]!.id, lines: [1] }]);

    expect(readFileSync(join(repo, "new.txt"), "utf-8")).toBe("alpha\ngamma\n");
    expect(await git(["status", "--porcelain"])).toBe("?? new.txt\n");
  });
});

describe("a file that was deleted", () => {
  beforeEach(() => {
    rmSync(join(repo, "file.txt"));
  });

  it("stages part of the deletion without claiming the whole file is gone", async () => {
    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "worktree");
    expect(hunks).toHaveLength(1);

    // Keep only the first two lines' removal. The other eighteen stay as
    // context, so `deleted file mode` is no longer true of this patch.
    await gitHunksService.stage(repo, "file.txt", [{ hunk: 0, id: hunks[0]!.id, lines: [0, 1] }]);

    const expected = ORIGINAL.split("\n").slice(2).join("\n");
    expect(sha(await stagedBytes("file.txt"))).toBe(sha(Buffer.from(expected, "utf-8")));
  });

  it("stages the whole deletion as a deletion", async () => {
    await gitHunksService.stage(repo, "file.txt", await pick("file.txt", "worktree", [0]));

    expect(await git(["status", "--porcelain"])).toBe("D  file.txt\n");
  });

  it("puts the file back when the deletion is discarded", async () => {
    await gitHunksService.discard(repo, "file.txt", await pick("file.txt", "worktree", [0]));

    expect(readFileSync(join(repo, "file.txt"), "utf-8")).toBe(ORIGINAL);
    expect(await git(["status", "--porcelain"])).toBe("");
  });
});
