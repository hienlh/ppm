/**
 * The routes behind Source Control, the Review tab and the Git Graph inspector:
 * the working tree's blocks, the shared commit message, discard Undo, and the
 * `git:changed` notice every write sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { onGitEvent } from "../../../src/services/git-changes/git-events.ts";
import type { GitEvent } from "../../../src/shared/git-changes.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let repo: string;
let events: GitEvent[] = [];
let unsubscribe: () => void;

function app() {
  const a = new Hono<Env>();
  a.use("/*", async (c, next) => {
    c.set("projectPath", repo);
    c.set("projectName", "demo");
    await next();
  });
  a.route("/git", gitRoutes);
  return a;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app().request(`/git${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

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
const write = (p: string, text: string) => writeFileSync(join(repo, p), text);
const read = (p: string) => readFileSync(join(repo, p), "utf8");

beforeAll(() => {
  unsubscribe = onGitEvent((e) => events.push(e));
});
afterAll(() => unsubscribe());

beforeEach(async () => {
  // The commit message lives in the database. An earlier file can leave a closed one installed
  // (draft-service.test.ts closes its own without taking it out), so each test brings its own.
  setDb(openTestDb());
  events = [];
  repo = mkdtempSync(join(tmpdir(), "ppm-git-routes-"));
  await git(["init", "-q", "-b", "main"]);
  // These tests compare bytes, and Git for Windows checks text out with CRLF by default.
  await git(["config", "core.autocrlf", "false"]);
  write("file.txt", ORIGINAL);
  await git(["add", "file.txt"]);
  await git(["commit", "-qm", "initial"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("GET /git/changes", () => {
  it("lists the working tree with blocks", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    const { status, body } = await call("GET", "/changes");
    expect(status).toBe(200);
    expect(body.data.branch.head).toBe("main");
    expect(body.data.files[0]).toMatchObject({ path: "file.txt", y: "M" });
    expect(body.data.files[0].unstaged.blocks).toHaveLength(1);
  });

  it("answers one file with its lines, and refuses a missing path", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    const { body } = await call("GET", "/changes/file?path=file.txt");
    expect(body.data.unstaged.hunks[0].lines.some((l: { text: string }) => l.text === "TWO")).toBe(true);
    expect((await call("GET", "/changes/file")).status).toBe(400);
  });
});

describe("the shared commit message", () => {
  it("is stored per repository and announced with the sender's id", async () => {
    expect((await call("GET", "/commit-draft")).body.data).toEqual({ message: "", updatedAt: null });
    const put = await call("PUT", "/commit-draft", { message: "Fix lanes", clientId: "tab-1" });
    expect(put.body.data.message).toBe("Fix lanes");
    expect((await call("GET", "/commit-draft")).body.data.message).toBe("Fix lanes");
    expect(events).toEqual([expect.objectContaining({
      type: "git:commit-draft", projectName: "demo", message: "Fix lanes", clientId: "tab-1",
    })]);
  });

  it("is cleared by a commit, and comes back with Undo last commit", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    await call("PUT", "/commit-draft", { message: "Two" });
    await git(["add", "file.txt"]);
    events = [];
    const commit = await call("POST", "/commit", { message: "Two" });
    expect(commit.status).toBe(200);
    expect((await call("GET", "/commit-draft")).body.data.message).toBe("");
    expect(events.map((e) => e.type)).toEqual(["git:commit-draft", "git:changed"]);

    const undo = await call("POST", "/commit/undo", { hash: commit.body.data.hash });
    expect(undo.status).toBe(200);
    expect(undo.body.data.message).toBe("Two");
    expect((await call("GET", "/commit-draft")).body.data.message).toBe("Two");
    expect(await git(["status", "--porcelain=v1"])).toBe("M  file.txt\n");
  });

  it("does not overwrite a message being written when a commit is undone", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    await git(["commit", "-qam", "Two"]);
    await call("PUT", "/commit-draft", { message: "Something else" });
    expect((await call("POST", "/commit/undo", { hash: (await git(["rev-parse", "HEAD"])).trim() })).status).toBe(200);
    expect((await call("GET", "/commit-draft")).body.data.message).toBe("Something else");
  });

  it("refuses to undo the root commit with a 409", async () => {
    const res = await call("POST", "/commit/undo", { hash: (await git(["rev-parse", "HEAD"])).trim() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/first commit/);
  });

  it("undoes only the commit it is asked to, and only while it is the last one", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    await git(["commit", "-qam", "Two"]);
    const meant = (await git(["rev-parse", "HEAD"])).trim();
    write("file.txt", ORIGINAL.replace("line-2\n", "THREE\n"));
    await git(["commit", "-qam", "Three, from a terminal"]);
    const res = await call("POST", "/commit/undo", { hash: meant });
    expect(res.status).toBe(409);
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe("Three, from a terminal");
    expect((await call("POST", "/commit/undo", {})).status).toBe(400);
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe("Three, from a terminal");
  });

  it("answers a commit on a detached HEAD with its hash, which is what Undo takes", async () => {
    await git(["config", "user.name", "T"]);
    await git(["config", "user.email", "t@e.x"]);
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    await git(["commit", "-qam", "Two"]);
    await git(["checkout", "-q", "--detach"]);
    write("file.txt", ORIGINAL.replace("line-2\n", "THREE\n"));
    await git(["add", "file.txt"]);
    const commit = await call("POST", "/commit", { message: "Three" });
    expect(commit.body.data.hash).toBe((await git(["rev-parse", "HEAD"])).trim());
    expect((await call("POST", "/commit/undo", { hash: commit.body.data.hash })).status).toBe(200);
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe("Two");
  });

  it("signs off when asked", async () => {
    await git(["config", "user.name", "Ada"]);
    await git(["config", "user.email", "ada@example.com"]);
    write("file.txt", "x\n");
    await git(["add", "file.txt"]);
    await call("POST", "/commit", { message: "Signed", signoff: true });
    expect(await git(["log", "-1", "--format=%B"])).toContain("Signed-off-by: Ada <ada@example.com>");
  });
});

describe("discard and Undo", () => {
  it("answers a block discard with an undo record that puts it back", async () => {
    write("file.txt", ORIGINAL.replace("line-2\n", "TWO\n"));
    const listed = (await call("GET", "/changes")).body.data.files[0].unstaged.blocks[0];
    const discard = await call("POST", "/discard-hunks", { path: "file.txt", hunks: [{ hunk: 0, id: listed.id }] });
    expect(read("file.txt")).toBe(ORIGINAL);
    const undo = await call("POST", "/discard/undo", { id: discard.body.data.undo.id });
    expect(undo.status).toBe(200);
    expect(read("file.txt")).toContain("TWO\n");
  });

  it("answers a file discard with an undo record, and 409 once the file moved on", async () => {
    write("file.txt", "mine\n");
    const discard = await call("POST", "/discard", { files: ["file.txt"] });
    expect(discard.body.data.undo.paths).toEqual(["file.txt"]);
    expect((await call("GET", "/discards")).body.data).toHaveLength(1);
    write("file.txt", "typed since\n");
    const undo = await call("POST", "/discard/undo", { id: discard.body.data.undo.id });
    expect(undo.status).toBe(409);
    expect(read("file.txt")).toBe("typed since\n");
  });

  it("does not discard anything when the path cannot be copied first", async () => {
    write("file.txt", "mine\n");
    const res = await call("POST", "/discard", { files: ["file.txt", ".git/config"] });
    expect(res.status).toBe(500);
    expect(read("file.txt")).toBe("mine\n");
  });
});

describe("git:changed", () => {
  it("follows every write, and only writes", async () => {
    await call("GET", "/changes");
    expect(events).toEqual([]);
    write("file.txt", "x\n");
    await call("POST", "/stage", { files: ["file.txt"] });
    expect(events).toEqual([{ type: "git:changed", projectName: "demo", repo }]);
  });

  it("follows a write that failed part way, since it may still have changed the tree", async () => {
    await call("POST", "/checkout", { ref: "no-such-branch" });
    expect(events.map((e) => e.type)).toEqual(["git:changed"]);
  });
});

describe("stash", () => {
  it("stashes, lists and pops", async () => {
    write("file.txt", "stashed\n");
    expect((await call("POST", "/stash", { message: "keep" })).status).toBe(200);
    const list = (await call("GET", "/stashes")).body.data;
    expect(list).toEqual([expect.objectContaining({ index: 0, message: "keep", branch: "main" })]);
    expect((await call("POST", "/stash/pop", { index: 0, hash: list[0].hash })).status).toBe(200);
    expect(read("file.txt")).toBe("stashed\n");
    expect((await call("POST", "/stash/pop", { index: 0 })).status).toBe(400);
  });
});

describe("POST /git/operation/:action", () => {
  it("answers 409 when nothing is under way, and 404 for an action it does not have", async () => {
    const abort = await call("POST", "/operation/abort", {});
    expect(abort.status).toBe(409);
    expect(abort.body.error).toMatch(/no merge/);
    expect((await app().request("/git/operation/skip", { method: "POST" })).status).toBe(404);
  });
});

describe("POST /git/fetch", () => {
  // A remote with a branch that was then deleted there: only a pruning fetch drops its copy here.
  async function remoteWithDeletedBranch(): Promise<string> {
    const remote = mkdtempSync(join(tmpdir(), "ppm-git-remote-"));
    await git(["init", "-q", "--bare", "-b", "main", remote]);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "origin", "main", "main:gone"]);
    await git(["fetch", "-q", "origin"]);
    await git(["--git-dir", remote, "branch", "-D", "gone"]);
    return remote;
  }
  const hasGone = async () => (await git(["for-each-ref", "refs/remotes/origin/gone"])).trim() !== "";

  it("keeps a branch the remote deleted unless asked to prune, and says the repository changed", async () => {
    const remote = await remoteWithDeletedBranch();
    try {
      expect((await call("POST", "/fetch", {})).status).toBe(200);
      expect(await hasGone()).toBe(true);
      expect(events.filter((e) => e.type === "git:changed")).toHaveLength(1);

      expect((await call("POST", "/fetch", { prune: true })).status).toBe(200);
      expect(await hasGone()).toBe(false);
      expect(events.filter((e) => e.type === "git:changed")).toHaveLength(2);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("refuses a remote git would read as an option", async () => {
    // `git fetch --prune-tags --prune` deletes every tag the remote does not have, and a tag has
    // no reflog to bring it back from.
    const remote = await remoteWithDeletedBranch();
    try {
      await git(["tag", "local-only"]);
      const res = await call("POST", "/fetch", { remote: "--prune-tags", prune: true });
      expect(res.status).toBe(400);
      expect((await git(["tag", "--list"])).trim()).toBe("local-only");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
