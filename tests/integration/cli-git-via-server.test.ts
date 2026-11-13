/**
 * `ppm git` with a server holding the database: every command goes through the project's git
 * routes, so each write is announced on `/ws/global` as `git:changed` — what makes Source Control,
 * the Review tab and the Git Graph refresh without a poll — and the routes' argument checks apply
 * to the CLI as to the browser. A stash that moved between the read and the pop is refused by the
 * route and the CLI shows why. With no server, the same routes run in-process after the notice.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
}

const gitChanged = async (project: string) =>
  (await server.events()).filter((e) => e.type === "git:changed" && e.projectName === project).length;

const ok = async (args: string[], h = home) => {
  const r = await runCli(h, args);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
  return r;
};

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null, undefined, "cli-chat-scratch-server-main.ts");
  repo = join(home, "work", "repo");
  initRepo(repo);
  await ok(["projects", "add", repo, "-n", "repo"]);
}, 90_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm git through the server", () => {
  it("stages, commits, branches, merges and tags, each POST announced as git:changed", async () => {
    const before = await gitChanged("repo");
    writeFileSync(join(repo, "a.txt"), "two\n");
    const stage = await ok(["git", "stage", "a.txt", "-p", "repo"]);
    expect(stage.stderr).toContain(`→ PPM default (ppm.db) at 127.0.0.1:${server.port}`);
    const status = JSON.parse((await ok(["git", "status", "-p", "repo", "--json"])).stdout);
    expect(status.files.map((f: { path: string; staged: unknown }) => [f.path, !!f.staged])).toEqual([["a.txt", true]]);

    const commit = await ok(["git", "commit", "-m", "second", "-p", "repo"]);
    expect(commit.stdout).toContain("Committed:");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("second");

    await ok(["git", "branch", "create", "feat", "-p", "repo"]);
    writeFileSync(join(repo, "b.txt"), "feat\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "on feat");
    await ok(["git", "branch", "checkout", "main", "-p", "repo"]);
    await ok(["git", "branch", "merge", "feat", "-p", "repo"]);
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    await ok(["git", "tag", "v1", "-p", "repo"]);
    expect(git(repo, "tag", "--list")).toBe("v1");
    // stage, commit, branch create, checkout, merge, tag: six writes, six announcements.
    expect(await gitChanged("repo")).toBe(before + 6);

    const log = await ok(["git", "log", "-n", "2", "-p", "repo"]);
    expect(log.stdout).toContain("on feat");
  });

  it("refuses an option given as a merge source, from the route", async () => {
    const r = await runCli(home, ["git", "branch", "merge", "-p", "repo", "--", "--no-ff"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid git ref for source");
  });

  it("discards with an undo id, and undoes it", async () => {
    writeFileSync(join(repo, "a.txt"), "scratch\n");
    const r = await ok(["git", "discard", "a.txt", "-p", "repo"]);
    const id = /ppm git undo discard (\S+)\)/.exec(r.stdout)?.[1];
    expect(id).toBeTruthy();
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
    await ok(["git", "undo", "discard", id!, "-p", "repo"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("scratch\n");
  });

  it("refuses to pop a stash that changed since it was read, with the route's message", async () => {
    await ok(["git", "stash", "save", "-m", "first stash", "-p", "repo"]);
    const [first] = JSON.parse((await ok(["git", "stash", "list", "-p", "repo", "--json"])).stdout) as Array<{ hash: string }>;
    writeFileSync(join(repo, "a.txt"), "another\n");
    git(repo, "stash", "push", "-q", "-m", "made outside PPM");

    const stale = await runCli(home, ["git", "stash", "pop", "0", "--expect", first!.hash, "-p", "repo"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("The stash list changed");
    expect(git(repo, "stash", "list").split("\n")).toHaveLength(2);

    await ok(["git", "stash", "pop", "1", "--expect", first!.hash, "-p", "repo"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("scratch\n");
  });

  it("scopes a command to a repository inside the project with --repo", async () => {
    const box = join(home, "work", "box");
    initRepo(join(box, "inner"));
    await ok(["projects", "add", box, "-n", "box"]);
    writeFileSync(join(box, "inner", "a.txt"), "changed\n");
    const status = JSON.parse((await ok(["git", "status", "-p", "box", "--repo", join(box, "inner"), "--json"])).stdout);
    expect(status.files.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
    const outside = await runCli(home, ["git", "status", "-p", "box", "--repo", repo]);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("repo is outside the project");
  });
});

describe("ppm git with no server", () => {
  it("runs the same route in-process after the direct-write notice", async () => {
    const solo = scratchHome();
    try {
      const dir = join(solo, "work", "solo");
      initRepo(dir);
      await ok(["projects", "add", dir, "-n", "solo"], solo);
      writeFileSync(join(dir, "a.txt"), "edited\n");
      const r = await ok(["git", "stage", "a.txt", "-p", "solo"], solo);
      expect(r.stderr).toContain("written directly");
      expect(git(dir, "diff", "--cached", "--name-only")).toBe("a.txt");
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  }, 60_000);
});
