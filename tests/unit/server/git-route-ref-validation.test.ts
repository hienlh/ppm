/**
 * The git write routes refuse any value git would read as something other than the field means —
 * an option, a range, a deleting or forcing refspec, an unknown remote, a folder that is not a
 * linked worktree — with a 400 that names the field, before git runs. Driven against a real
 * scratch repository with a bare remote, so the values that pass are shown to reach git and work.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let root: string;
let repo: string;
let head: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function app() {
  const a = new Hono<Env>();
  a.use("/*", async (c, next) => {
    c.set("projectPath", repo);
    c.set("projectName", "scratch");
    await next();
  });
  a.route("/git", gitRoutes);
  return a;
}

async function post(sub: string, body: unknown) {
  const res = await app().request(`/git/${sub}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
}

async function refused(sub: string, body: unknown, field: string) {
  const r = await post(sub, body);
  expect({ sub, body, status: r.status }).toEqual({ sub, body, status: 400 });
  expect(r.json.error ?? "").toContain(field);
}

beforeAll(async () => {
  setDb(openTestDb());
  root = mkdtempSync(join(tmpdir(), "ppm-git-args-"));
  repo = join(root, "repo");
  const bare = join(root, "remote.git");
  git(root, "init", "-q", "--bare", bare);
  git(root, "init", "-q", "-b", "main", repo);
  await Bun.write(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "branch", "side");
  head = git(repo, "rev-parse", "HEAD");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("git write routes refuse option-shaped arguments", () => {
  it("merge: an option, a range or a refspec is not a source", async () => {
    await refused("merge", { source: "--no-ff" }, "source");
    await refused("merge", { source: "-x" }, "source");
    await refused("merge", { source: "main..side" }, "source");
    await refused("merge", { source: "+main" }, "source");
  });

  it("branch/delete: the name cannot be an option", async () => {
    await refused("branch/delete", { name: "-D" }, "name");
    await refused("branch/delete", { name: "--exec=touch x" }, "name");
  });

  it("cherry-pick, revert and tag take only a commit hash", async () => {
    for (const hash of ["--exec=touch x", "-x", "HEAD~1", "abc", "main"]) {
      await refused("cherry-pick", { hash }, "hash");
      await refused("revert", { hash }, "hash");
      await refused("tag", { name: "v1", hash }, "hash");
    }
    await refused("tag", { name: "-f" }, "name");
    await refused("tag", { name: "a..b" }, "name");
  });

  it("push: the remote must be one this repository has, the branch a name or a qualified refspec", async () => {
    await refused("push", { remote: "--force" }, "remote");
    await refused("push", { remote: "--mirror" }, "remote");
    await refused("push", { remote: "upstream" }, "remote");
    await refused("push", { remote: "origin", branch: ":main" }, "branch");
    await refused("push", { remote: "origin", branch: "+main" }, "branch");
    await refused("push", { remote: "origin", branch: "-x" }, "branch");
    await refused("push", { remote: "origin", branch: "refs/heads/main:" }, "branch");
    await refused("push", { remote: "origin", branch: "main:refs/heads/main" }, "branch");
    await refused("push", { branch: "main" }, "branch");
  });

  it("worktree add and remove refuse an option and anything that is not a linked worktree", async () => {
    await refused("worktree/add", { path: join(root, "wt-x"), branch: "-x" }, "branch");
    await refused("worktree/add", { path: join(root, "wt-x"), newBranch: "--detach" }, "newBranch");
    await refused("worktree/remove", { path: "--force" }, "path");
    await refused("worktree/remove", { path: repo }, "path");
    await refused("worktree/remove", { path: join(root, "elsewhere") }, "path");
  });
});

describe("values that pass reach git", () => {
  it("pushes a plain branch and the Assistant's qualified refspec to a configured remote", async () => {
    expect((await post("push", { remote: "origin", branch: "main" })).status).toBe(200);
    expect((await post("push", { remote: "origin", branch: "refs/heads/side:refs/heads/side" })).status).toBe(200);
    expect(git(root, "--git-dir", join(root, "remote.git"), "branch", "--list")).toContain("side");
  });

  it("tags a hash and merges and deletes a branch by name", async () => {
    expect((await post("tag", { name: "v1", hash: head.slice(0, 7) })).status).toBe(200);
    expect((await post("merge", { source: "side" })).status).toBe(200);
    expect((await post("branch/delete", { name: "side" })).status).toBe(200);
  });

  it("adds a worktree and removes it by the path it was added at", async () => {
    const wt = join(root, "wt-ok");
    expect((await post("worktree/add", { path: wt, newBranch: "wt-branch" })).status).toBe(200);
    expect((await post("worktree/remove", { path: wt })).status).toBe(200);
  });
});
