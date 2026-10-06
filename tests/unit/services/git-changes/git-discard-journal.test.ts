/**
 * Undo for discards, against real repositories. PPM_HOME is the preload's
 * scratch directory, so the journal never reaches the real one.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiscardJournal } from "../../../../src/services/git-discard-journal/git-discard-journal.service.ts";
import { gitHunksService } from "../../../../src/services/git-hunks/git-hunks.service.ts";
import { gitService } from "../../../../src/services/git.service.ts";
import { getPpmDir } from "../../../../src/services/ppm-dir.ts";

let repo: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.x" },
  });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  return out;
}

const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const write = (p: string, text: string | Buffer) => writeFileSync(join(repo, p), text);

/** Discard whole files the way the route does: copy, discard, record. */
async function discardFiles(paths: string[]) {
  const pending = await gitDiscardJournal.captureFiles(repo, paths);
  await gitService.discardChanges(repo, paths);
  return gitDiscardJournal.commitFiles(pending);
}

/** The journal's directory that holds this entry. */
function journalDirOf(id: string): string {
  const root = join(getPpmDir(), "git-discards");
  const dir = readdirSync(root).find((d) => existsSync(join(root, d, `${id}.json`)));
  if (!dir) throw new Error(`no entry ${id}`);
  return join(root, dir);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-discard-"));
  await git(["init", "-q", "-b", "main"]);
  // These tests compare bytes, and Git for Windows checks text out with CRLF by default.
  await git(["config", "core.autocrlf", "false"]);
  write("file.txt", ORIGINAL);
  write("run.sh", "echo hi\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  write("logo.bin", Buffer.from([0, 1, 2, 3, 255]));
  await git(["add", "-A"]);
  await git(["commit", "-qm", "initial"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("block discards", () => {
  async function discardFirstHunk() {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n").replace("line-18\n", "EIGHTEEN\n"));
    const { hunks } = await gitHunksService.getHunks(repo, "file.txt", "worktree");
    const patch = await gitHunksService.discard(repo, "file.txt", [{ hunk: 0, id: hunks[0]!.id }]);
    return gitDiscardJournal.recordHunks(repo, "file.txt", patch);
  }

  it("puts the discarded block back", async () => {
    const record = await discardFirstHunk();
    expect(read("file.txt")).toBe(ORIGINAL.replace("line-18\n", "EIGHTEEN\n"));
    expect(record.hunks![0]!.lines.filter((l) => l.kind !== " ").map((l) => l.kind + l.text))
      .toEqual(["-line-2", "+TWO"]);

    await gitDiscardJournal.undo(repo, record.id);
    expect(read("file.txt")).toBe(ORIGINAL.replace("line-2\n", "TWO\n").replace("line-18\n", "EIGHTEEN\n"));
  });

  it("keeps working after the other block was staged", async () => {
    const record = await discardFirstHunk();
    await git(["add", "file.txt"]);
    await gitDiscardJournal.undo(repo, record.id);
    expect(read("file.txt")).toContain("TWO\n");
  });

  it("refuses once the lines around it were edited, and changes nothing", async () => {
    const record = await discardFirstHunk();
    const edited = read("file.txt").replace("line-3\n", "EDITED-3\n");
    write("file.txt", edited);
    await expect(gitDiscardJournal.undo(repo, record.id)).rejects.toThrow(/edited after this change was discarded/);
    expect(read("file.txt")).toBe(edited);
  });

  it("does not put a block back where a copy of its lines moved to", async () => {
    // The same seven lines twice. The block is discarded from the second copy; then lines
    // pushed that copy further from where the patch says it was than the first copy is,
    // and `git apply` takes the nearest match: the first copy, which never had the change.
    const same = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const committed = [...same, "----", ...same].join("\n") + "\n";
    write("twice.txt", committed);
    await git(["add", "twice.txt"]);
    await git(["commit", "-qm", "twice"]);
    write("twice.txt", committed.replace(/s4\n(?![\s\S]*s4\n)/, "CHANGED\n"));
    const { hunks } = await gitHunksService.getHunks(repo, "twice.txt", "worktree");
    const patch = await gitHunksService.discard(repo, "twice.txt", [{ hunk: 0, id: hunks[0]!.id }]);
    const record = await gitDiscardJournal.recordHunks(repo, "twice.txt", patch);
    const edited = committed.replace("----\n", "----\n" + "added\n".repeat(20));
    write("twice.txt", edited);
    await expect(gitDiscardJournal.undo(repo, record.id)).rejects.toThrow(/edited after this change was discarded/);
    expect(read("twice.txt")).toBe(edited);
  });

  it("can be undone once only, and is listed until then", async () => {
    const record = await discardFirstHunk();
    expect((await gitDiscardJournal.list(repo)).map((r) => r.id)).toEqual([record.id]);
    await gitDiscardJournal.undo(repo, record.id);
    expect(await gitDiscardJournal.list(repo)).toEqual([]);
    await expect(gitDiscardJournal.undo(repo, record.id)).rejects.toThrow(/no longer be undone/);
  });
});

describe("whole-file discards", () => {
  it("restores a modified file, its mode included", async () => {
    write("run.sh", "echo changed\n");
    const record = await discardFiles(["run.sh"]);
    expect(read("run.sh")).toBe("echo hi\n");
    await gitDiscardJournal.undo(repo, record.id);
    expect(read("run.sh")).toBe("echo changed\n");
    // Windows has no execute bit to keep: its modes are 0o666 or 0o444.
    if (process.platform !== "win32") expect(lstatSync(join(repo, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("restores an untracked file and a binary one byte for byte", async () => {
    mkdirSync(join(repo, "notes"));
    write("notes/new.md", "# draft\n");
    write("logo.bin", Buffer.from([0, 9, 9, 9, 255]));
    const record = await discardFiles(["notes/new.md", "logo.bin"]);
    expect(existsSync(join(repo, "notes/new.md"))).toBe(false);
    await gitDiscardJournal.undo(repo, record.id);
    expect(read("notes/new.md")).toBe("# draft\n");
    expect([...readFileSync(join(repo, "logo.bin"))]).toEqual([0, 9, 9, 9, 255]);
  });

  it("deletes again a file whose deletion was discarded", async () => {
    unlinkSync(join(repo, "file.txt"));
    const record = await discardFiles(["file.txt"]);
    expect(existsSync(join(repo, "file.txt"))).toBe(true);
    await gitDiscardJournal.undo(repo, record.id);
    expect(existsSync(join(repo, "file.txt"))).toBe(false);
  });

  // A file symlink needs Developer Mode on Windows.
  it.skipIf(process.platform === "win32")("restores a symlink as a symlink", async () => {
    symlinkSync("file.txt", join(repo, "link"));
    await git(["add", "link"]);
    await git(["commit", "-qm", "link"]);
    unlinkSync(join(repo, "link"));
    symlinkSync("run.sh", join(repo, "link"));
    const record = await discardFiles(["link"]);
    expect(readlinkSync(join(repo, "link"))).toBe("file.txt");
    await gitDiscardJournal.undo(repo, record.id);
    expect(readlinkSync(join(repo, "link"))).toBe("run.sh");
  });

  it("refuses, restoring nothing, when any file changed after the discard", async () => {
    write("file.txt", "mine\n");
    write("run.sh", "echo mine\n");
    const record = await discardFiles(["file.txt", "run.sh"]);
    write("run.sh", "echo typed since\n");
    await expect(gitDiscardJournal.undo(repo, record.id)).rejects.toThrow(/run\.sh changed after/);
    expect(read("file.txt")).toBe(ORIGINAL);
    expect(read("run.sh")).toBe("echo typed since\n");
  });

  it("is written down before the discard, so one PPM never finished noting can still be undone", async () => {
    write("file.txt", "mine\n");
    write("new.md", "# draft\n");
    const pending = await gitDiscardJournal.captureFiles(repo, ["file.txt", "new.md"]);
    await gitService.discardChanges(repo, ["file.txt", "new.md"]);
    // PPM stopped here, before `commitFiles`.
    expect((await gitDiscardJournal.list(repo)).map((r) => r.id)).toEqual([pending.entry.id]);
    await gitDiscardJournal.undo(repo, pending.entry.id);
    expect(read("file.txt")).toBe("mine\n");
    expect(read("new.md")).toBe("# draft\n");
  });

  it("never lets an entry PPM did not finish overwrite an edit made since", async () => {
    write("file.txt", "mine\n");
    write("new.md", "# draft\n");
    const pending = await gitDiscardJournal.captureFiles(repo, ["file.txt", "new.md"]);
    await gitService.discardChanges(repo, ["file.txt", "new.md"]);
    write("new.md", "typed since\n");
    await expect(gitDiscardJournal.undo(repo, pending.entry.id)).rejects.toThrow(/new\.md changed after/);
    expect(read("file.txt")).toBe(ORIGINAL);
    expect(read("new.md")).toBe("typed since\n");
  });

  it("keeps what a discard that failed part way already threw away", async () => {
    write("file.txt", "mine\n");
    write("run.sh", "echo mine\n");
    const pending = await gitDiscardJournal.captureFiles(repo, ["file.txt", "run.sh"]);
    await git(["checkout", "--", "file.txt"]); // and then the discard failed
    const record = await gitDiscardJournal.failed(pending);
    expect(record?.paths).toEqual(["file.txt", "run.sh"]);
    const untouched = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(repo, "run.sh"), untouched, untouched);
    await gitDiscardJournal.undo(repo, record!.id);
    expect(read("file.txt")).toBe("mine\n");
    expect(read("run.sh")).toBe("echo mine\n");
    // The file the discard never reached is left alone, not written again.
    expect(statSync(join(repo, "run.sh")).mtimeMs).toBe(untouched.getTime());
  });

  it("keeps those copies even when what the discard did cannot be noted", async () => {
    write("file.txt", "mine\n");
    const pending = await gitDiscardJournal.captureFiles(repo, ["file.txt"]);
    await git(["checkout", "--", "file.txt"]); // and then the discard failed
    const commit = spyOn(gitDiscardJournal, "commitFiles").mockRejectedValue(new Error("disk full"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let record: Awaited<ReturnType<typeof gitDiscardJournal.failed>>;
    try {
      record = await gitDiscardJournal.failed(pending);
    } finally {
      commit.mockRestore();
      errors.mockRestore();
    }
    expect(record?.id).toBe(pending.entry.id);
    await gitDiscardJournal.undo(repo, record!.id);
    expect(read("file.txt")).toBe("mine\n");
  });

  it("forgets a discard that failed before changing anything", async () => {
    write("file.txt", "mine\n");
    const pending = await gitDiscardJournal.captureFiles(repo, ["file.txt"]);
    const dir = journalDirOf(pending.entry.id);
    expect(await gitDiscardJournal.failed(pending)).toBeNull();
    expect(readdirSync(dir).filter((n) => n.startsWith(pending.entry.id))).toEqual([]);
    expect(await gitDiscardJournal.list(repo)).toEqual([]);
  });

  it("leaves no copy behind when one of the paths cannot be taken", async () => {
    write("file.txt", "mine\n");
    const kept = await discardFiles(["run.sh"]); // so the journal's directory exists
    const dir = journalDirOf(kept.id);
    const before = readdirSync(dir).sort();
    await expect(gitDiscardJournal.captureFiles(repo, ["file.txt", ".git/config"])).rejects.toThrow(/Refusing/);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("does not copy a file over 20 MB, and says so", async () => {
    write("huge.bin", Buffer.alloc(21 * 1024 * 1024, 7));
    const record = await discardFiles(["huge.bin"]);
    expect(record.skipped).toEqual(["huge.bin"]);
    expect(record.paths).toEqual([]);
  });

  it("refuses paths outside the repository or inside .git", async () => {
    await expect(gitDiscardJournal.captureFiles(repo, ["../outside.txt"])).rejects.toThrow();
    await expect(gitDiscardJournal.captureFiles(repo, [".git/config"])).rejects.toThrow(/Refusing/);
  });

  it("refuses to write through a symlinked directory that leads out of the repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ppm-discard-outside-"));
    try {
      symlinkSync(outside, join(repo, "escape"), "junction");
      await expect(gitDiscardJournal.captureFiles(repo, ["escape/file.txt"])).rejects.toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("retention", () => {
  it("drops copies no entry names once they are a day old", async () => {
    write("file.txt", "mine\n");
    const record = await discardFiles(["file.txt"]);
    const dir = journalDirOf(record.id);
    // What a capture PPM stopped in the middle of leaves: copies, and no entry.
    const old = join(dir, "00000000-0000-4000-8000-000000000000.0.bin");
    const fresh = join(dir, "00000000-0000-4000-8000-000000000001.0.bin");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    await gitDiscardJournal.list(repo);
    expect(existsSync(old)).toBe(false);
    // Younger than a day it may be a capture still running.
    expect(existsSync(fresh)).toBe(true);
    expect((await gitDiscardJournal.list(repo)).map((r) => r.id)).toEqual([record.id]);
  });

  it("keeps the newest 100 entries per repository", async () => {
    write("file.txt", "x\n");
    const ids: string[] = [];
    for (let i = 0; i < 102; i++) ids.push((await gitDiscardJournal.recordHunks(repo, "file.txt", "")).id);
    const listed = (await gitDiscardJournal.list(repo)).map((r) => r.id);
    expect(listed).toHaveLength(100);
    expect(listed).not.toContain(ids[0]);
    expect(listed).toContain(ids[101]);
    expect(getPpmDir()).not.toContain("/.ppm");
    const dir = readdirSync(join(getPpmDir(), "git-discards"));
    expect(dir.length).toBeGreaterThan(0);
  });
});
