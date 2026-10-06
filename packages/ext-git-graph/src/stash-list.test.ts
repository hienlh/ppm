/**
 * A stash row shows who made the stash and when, read from one `git stash list`.
 * A name or a message may hold any printable character, `|` included, so the
 * fields are split by the unit separator; this runs real git to prove it.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STASH_FORMAT, parseStashes } from "./extension.ts";

let repo = "";
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const as = (name: string, email: string) => ["-c", `user.name=${name}`, "-c", `user.email=${email}`];

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "gg-stash-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git(...as("Base", "base@example.com"), "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git(...as("Ann | Lee", "ann@example.com"), "stash", "push", "-q", "-m", "keep a|b apart");
  writeFileSync(join(repo, "a.txt"), "three\n");
  git(...as("Bo", "bo@example.com"), "stash", "push", "-q");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("the stash list", () => {
  it("reads every field of every stash, newest first", () => {
    const stashes = parseStashes(git("stash", "list", `--format=${STASH_FORMAT}`));
    const head = git("rev-parse", "HEAD");
    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
    expect(stashes[0]).toMatchObject({ hash: git("rev-parse", "stash@{0}"), parentHash: head, author: "Bo", authorEmail: "bo@example.com" });
    expect(stashes[0]!.message).toStartWith("WIP on main: ");
    expect(stashes[1]).toMatchObject({
      hash: git("rev-parse", "stash@{1}"),
      parentHash: head,
      message: "On main: keep a|b apart",
      author: "Ann | Lee",
      authorEmail: "ann@example.com",
    });
    expect(stashes[1]!.date).toBe(Number(git("log", "-1", "--format=%at", "stash@{1}")));
  });

  it("reads nothing when there are no stashes", () => {
    expect(parseStashes("")).toEqual([]);
  });
});
