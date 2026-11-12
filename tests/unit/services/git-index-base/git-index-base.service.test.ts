/**
 * The file as the index holds it, against real repositories: what the editor's
 * change bars compare the buffer with.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitIndexBaseService } from "../../../../src/services/git-index-base/git-index-base.service.ts";

let repo: string;

/** Keep the real environment — replacing it drops HOME and git ignores config. */
async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com",
    },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-index-base-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "file.txt"), "alpha\nbeta\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-qm", "first"]);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("gitIndexBaseService.read", () => {
  it("answers the index's version, not the working tree's", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nBETA\n");
    const answer = await gitIndexBaseService.read(repo, "file.txt");
    expect(answer).toMatchObject({ state: "ok", content: "alpha\nbeta\n" });
  });

  it("follows a stage: what was added is the new base", async () => {
    writeFileSync(join(repo, "file.txt"), "alpha\nstaged\n");
    await git(["add", "file.txt"]);
    writeFileSync(join(repo, "file.txt"), "alpha\nstaged\nnot yet\n");
    expect(await gitIndexBaseService.read(repo, "file.txt")).toMatchObject({ state: "ok", content: "alpha\nstaged\n" });
  });

  it("answers `same` with no content while the index still names the known blob", async () => {
    const first = await gitIndexBaseService.read(repo, "file.txt");
    if (first.state !== "ok") throw new Error(`expected ok, got ${first.state}`);
    expect(await gitIndexBaseService.read(repo, "file.txt", first.oid)).toEqual({ state: "same", oid: first.oid });

    writeFileSync(join(repo, "file.txt"), "changed\n");
    await git(["add", "file.txt"]);
    expect(await gitIndexBaseService.read(repo, "file.txt", first.oid)).toMatchObject({ state: "ok", content: "changed\n" });
  });

  it("has nothing for an untracked file, or one that does not exist", async () => {
    writeFileSync(join(repo, "new.txt"), "x\n");
    expect(await gitIndexBaseService.read(repo, "new.txt")).toEqual({ state: "none", reason: "untracked" });
    expect(await gitIndexBaseService.read(repo, "missing.txt")).toEqual({ state: "none", reason: "untracked" });
  });

  it("does not read a directory's contents as the file", async () => {
    mkdirSync(join(repo, "dir"));
    writeFileSync(join(repo, "dir", "a.txt"), "a\n");
    await git(["add", "dir"]);
    expect(await gitIndexBaseService.read(repo, "dir")).toEqual({ state: "none", reason: "untracked" });
  });

  it("takes the path literally, so a name with glob characters is that one file", async () => {
    writeFileSync(join(repo, "a*.txt"), "star\n");
    writeFileSync(join(repo, "ab.txt"), "other\n");
    await git(["add", "--", "a*.txt", "ab.txt"]);
    expect(await gitIndexBaseService.read(repo, "a*.txt")).toMatchObject({ state: "ok", content: "star\n" });
    expect(await gitIndexBaseService.read(repo, "a?.txt")).toEqual({ state: "none", reason: "untracked" });
  });

  it("reads paths relative to where git runs, as from a project folder inside a repository", async () => {
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "pkg", "inner.ts"), "inner\n");
    await git(["add", "pkg"]);
    expect(await gitIndexBaseService.read(join(repo, "pkg"), "inner.ts")).toMatchObject({ state: "ok", content: "inner\n" });
  });

  it("applies end-of-line conversion as checkout would, so an autocrlf file is not all changed", async () => {
    await git(["config", "core.autocrlf", "true"]);
    const answer = await gitIndexBaseService.read(repo, "file.txt");
    expect(answer).toMatchObject({ state: "ok", content: "alpha\r\nbeta\r\n" });
  });

  it("refuses a binary file and one past the size cap, keeping the blob id", async () => {
    writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    await git(["add", "bin.dat"]);
    expect(await gitIndexBaseService.read(repo, "bin.dat")).toMatchObject({ state: "none", reason: "binary" });
    const large = await gitIndexBaseService.read(repo, "file.txt", undefined, 4);
    expect(large).toMatchObject({ state: "none", reason: "too-large" });
    expect(large.state === "none" && large.oid).toBeTruthy();
  });

  it("has nothing for a symlink, whose index entry is the link's target path", async () => {
    symlinkSync("file.txt", join(repo, "link.txt"));
    await git(["add", "link.txt"]);
    expect(await gitIndexBaseService.read(repo, "link.txt")).toEqual({ state: "none", reason: "not-a-file" });
  });

  it("has nothing mid-merge, when the index holds three versions", async () => {
    await git(["checkout", "-qb", "other"]);
    writeFileSync(join(repo, "file.txt"), "alpha\nother\n");
    await git(["commit", "-qam", "other"]);
    await git(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "file.txt"), "alpha\nmain\n");
    await git(["commit", "-qam", "main"]);
    await git(["merge", "other"]).catch(() => {});
    expect(await gitIndexBaseService.read(repo, "file.txt")).toEqual({ state: "none", reason: "conflict" });
  });

  it("reads a non-ASCII path", async () => {
    writeFileSync(join(repo, "tệp.txt"), "xin chào\n");
    await git(["add", "tệp.txt"]);
    expect(await gitIndexBaseService.read(repo, "tệp.txt")).toMatchObject({ state: "ok", content: "xin chào\n" });
  });

  it("rejects a path that escapes the repository or reads as an option", async () => {
    await expect(gitIndexBaseService.read(repo, "../etc/passwd")).rejects.toThrow();
    await expect(gitIndexBaseService.read(repo, "--output=x")).rejects.toThrow();
    await expect(gitIndexBaseService.read(repo, "/etc/passwd")).rejects.toThrow();
  });
});
