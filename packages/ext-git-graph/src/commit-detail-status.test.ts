/**
 * The inspector marks each file A, M, D or R. That letter used to be guessed
 * from the line counts — only added lines meant "added" — so a commit that
 * appended to an existing file listed it as a new one. git says which files it
 * created or deleted in `--summary`; this runs real git to hold the host to it.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETAIL_FORMAT, parseCommitDetail } from "./extension.ts";

let repo = "";
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const put = (name: string, text: string) => writeFileSync(join(repo, name), text);
const statuses = (detail: ReturnType<typeof parseCommitDetail>) =>
  Object.fromEntries(detail.fileChanges.map((f) => [f.path, f.status]));

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "gg-status-"));
  git("init", "-q", "-b", "main");
  put("grows.txt", "one\ntwo\n");
  put("shrinks.txt", "one\ntwo\nthree\n");
  put("goes.txt", "bye\n");
  put("moves.txt", "a line long enough to be recognised as the same file\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  put("grows.txt", "one\ntwo\nthree\n");
  put("shrinks.txt", "one\n");
  put("new.txt", "hello\n");
  unlinkSync(join(repo, "goes.txt"));
  renameSync(join(repo, "moves.txt"), join(repo, "moved.txt"));
  git("add", "-A");
  git("commit", "-q", "-m", "change");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("a commit's files", () => {
  it("take their letter from what git did, not from the line counts", () => {
    const detail = parseCommitDetail(git("show", "--numstat", "--summary", DETAIL_FORMAT, "HEAD"));
    expect(statuses(detail)).toEqual({
      "grows.txt": "M",
      "shrinks.txt": "M",
      "new.txt": "A",
      "goes.txt": "D",
      "moved.txt": "R",
    });
    expect(detail.fileChanges.find((f) => f.path === "moved.txt")?.oldPath).toBe("moves.txt");
    expect(detail.message).toBe("change");
  });
});

describe("a stash's files", () => {
  it("say whether the stash changed a file or brought it in", () => {
    put("grows.txt", "one\ntwo\nthree\nfour\n");
    put("untracked.txt", "new\n");
    git("stash", "push", "-q", "-u");
    const hash = git("rev-parse", "stash@{0}").trim();
    // The same three reads the host makes for a stash.
    const header = git("show", "-s", DETAIL_FORMAT, hash);
    const tracked = git("diff", "--numstat", "--summary", `${hash}^1`, hash);
    const untracked = git("show", "--numstat", "--summary", "--format=", `${hash}^3`);
    const detail = parseCommitDetail(`${header.trimEnd()}\n${tracked}\n${untracked}`);
    expect(statuses(detail)).toEqual({ "grows.txt": "M", "untracked.txt": "A" });
  });

  it("are read by the host with the same arguments", () => {
    const host = readFileSync(new URL("./extension.ts", import.meta.url), "utf8");
    expect(host).toContain('spawnGit(vscode, ["show", "--numstat", "--summary", DETAIL_FORMAT, hash], projectPath)');
    expect(host).toContain('spawnGit(vscode, ["diff", "--numstat", "--summary", `${hash}^1`, hash], projectPath)');
    expect(host).toContain('spawnGit(vscode, ["show", "--numstat", "--summary", "--format=", `${hash}^3`], projectPath)');
  });
});
