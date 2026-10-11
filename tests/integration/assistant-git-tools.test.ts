/**
 * The Assistant's git tools against real repositories, through the real routes the UI calls
 * (in-process, by `createRouteCaller(GIT_ROUTES)`): stage → commit → push to a bare remote,
 * discard and its Undo, branch create and switch, stash save and pop, a container project with
 * two repositories, and the `git:changed` broadcast each write leaves for Source Control.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../src/services/config.service.ts";
import { onGitEvent } from "../../src/services/git-changes/git-events.ts";
import { createRouteCaller } from "../../src/services/assistant-mcp/assistant-route-call.ts";
import { GIT_ROUTES, GIT_TOOL_HANDLERS } from "../../src/services/assistant-mcp/assistant-git-tools.ts";
import { noApprover, type ApprovalAsk } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../src/services/assistant-mcp/assistant-tool-family.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A repository with one commit; its identity is in its own config, so PPM's commits work too. */
function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(path, "a.txt"), "one\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "first"]);
}

let root: string;
let solo: string;
let box: string;
let savedProjects: unknown;

beforeAll(async () => {
  // The order a running PPM has: the server's module graph first, then the lazily built app.
  await import("../../src/server/index.ts");
  root = mkdtempSync(join(tmpdir(), "ppm-assistant-git-"));
  const remote = join(root, "remote.git");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  solo = join(root, "solo");
  makeRepo(solo);
  git(solo, ["remote", "add", "origin", remote]);
  git(solo, ["push", "-q", "-u", "origin", "main"]);
  box = join(root, "box");
  makeRepo(join(box, "one"));
  makeRepo(join(box, "two"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "solo", path: solo }, { name: "box", path: box }]);
});

afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(root, { recursive: true, force: true });
});

const call = createRouteCaller(GIT_ROUTES);
const asked: ApprovalAsk[] = [];
const approve: ToolContext = { sessionId: "s-1", callRoute: call, ask: async (a) => { asked.push(a); return { verdict: "approved" }; } };
const events: Array<{ type: string; projectName: string; repo: string }> = [];
const off = onGitEvent((e) => { if (e.type === "git:changed") events.push(e as never); });
afterAll(off);
afterEach(() => { events.length = 0; asked.length = 0; });

const result = (r: Record<string, unknown>) => {
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};
const tool = async (name: string, args: Record<string, unknown>, ctx: ToolContext = approve) => GIT_TOOL_HANDLERS[name]!(ctx, args);

describe("git tools on a real repository", () => {
  it("stage → commit → push, each write broadcasting git:changed once", async () => {
    writeFileSync(join(solo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(solo, "b.txt"), "new\n");
    result(await tool("git_stage", { project: "solo", files: ["a.txt", "b.txt"] }));
    expect(events).toEqual([expect.objectContaining({ type: "git:changed", projectName: "solo" })]);

    events.length = 0;
    const committed = result(await tool("git_commit", { project: "solo", message: "add b" }));
    expect(committed.committed).toMatch(/^[0-9a-f]{7,}$/);
    expect(asked.at(-1)!.summary.body!.text).toBe("Files (2):\nM  a.txt\nA  b.txt\n\nMessage:\nadd b");
    expect(events).toHaveLength(1);
    expect(git(solo, ["log", "-1", "--format=%s"])).toBe("add b");

    const before = result(await tool("git_status", { project: "solo" }));
    expect(before.branch).toMatchObject({ name: "main", upstream: "origin/main", ahead: 1 });
    expect(before.files).toEqual([]);

    events.length = 0;
    result(await tool("git_sync", { project: "solo", action: "push" }));
    expect(events).toHaveLength(1);
    expect(result(await tool("git_status", { project: "solo" })).branch.ahead).toBe(0);
  });

  it("undoes the last commit while it is not pushed, and refuses once it is", async () => {
    writeFileSync(join(solo, "c.txt"), "c\n");
    result(await tool("git_stage", { project: "solo", files: ["c.txt"] }));
    const { committed } = result(await tool("git_commit", { project: "solo", message: "add c" }));
    result(await tool("git_undo", { project: "solo", kind: "commit", hash: committed }));
    expect(git(solo, ["log", "-1", "--format=%s"])).toBe("add b");
    expect(git(solo, ["diff", "--cached", "--name-only"])).toBe("c.txt");
    // Back to a clean, pushed tree for the tests after this one.
    result(await tool("git_stage", { project: "solo", files: ["c.txt"], unstage: true }));
    rmSync(join(solo, "c.txt"));
    const pushedHead = git(solo, ["rev-parse", "HEAD"]);
    asked.length = 0;
    expect((await tool("git_undo", { project: "solo", kind: "commit", hash: pushedHead })).isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("discards a change and writes it back with git_undo", async () => {
    writeFileSync(join(solo, "a.txt"), "changed\n");
    const out = result(await tool("git_discard", { project: "solo", files: ["a.txt"] }));
    expect(readFileSync(join(solo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(typeof out.undo.id).toBe("string");
    const status = result(await tool("git_status", { project: "solo" }));
    expect(status.undoableDiscards.map((d: { id: string }) => d.id)).toContain(out.undo.id);
    result(await tool("git_undo", { project: "solo", kind: "discard", id: out.undo.id }));
    expect(readFileSync(join(solo, "a.txt"), "utf8")).toBe("changed\n");
    git(solo, ["checkout", "--", "a.txt"]);
  });

  it("creates a branch, switches back, and stashes and pops a change", async () => {
    expect(result(await tool("git_branch", { project: "solo", action: "create", name: "feature/x" })).current).toBe("feature/x");
    expect(git(solo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x");
    result(await tool("git_branch", { project: "solo", action: "switch", name: "main" }));
    expect(git(solo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

    writeFileSync(join(solo, "a.txt"), "stashed\n");
    const saved = result(await tool("git_stash", { project: "solo", action: "save", message: "wip `x`" }));
    expect(saved.stashed).toBe(true);
    expect(readFileSync(join(solo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    const listed = result(await tool("git_status", { project: "solo" })).stashes;
    expect(listed[0]).toMatchObject({ index: 0, message: "wip `x`" });
    result(await tool("git_stash", { project: "solo", action: "pop", index: 0 }));
    expect(readFileSync(join(solo, "a.txt"), "utf8")).toBe("stashed\n");
    git(solo, ["checkout", "--", "a.txt"]);
  });

  it("changes nothing without an approval", async () => {
    writeFileSync(join(solo, "a.txt"), "keep\n");
    for (const [name, args] of [
      ["git_stage", { files: ["a.txt"] }], ["git_discard", { files: ["a.txt"] }], ["git_stash", { action: "save" }],
    ] as const) {
      expect((await tool(name, { project: "solo", ...args }, { ...approve, ask: noApprover })).isError).toBe(true);
    }
    expect(readFileSync(join(solo, "a.txt"), "utf8")).toBe("keep\n");
    expect(git(solo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(events).toHaveLength(0);
    git(solo, ["checkout", "--", "a.txt"]);
  });
});

describe("a container project", () => {
  it("lists its repositories, works in the named one, and refuses one it does not hold", async () => {
    const listed = result(await tool("git_status", { project: "box" }));
    expect(listed.repositories.map((r: { relative: string }) => r.relative)).toEqual(["one", "two"]);
    expect((await tool("git_status", { project: "box", repo: "../solo" })).isError).toBe(true);

    writeFileSync(join(box, "two", "a.txt"), "edited\n");
    result(await tool("git_stage", { project: "box", repo: "two", files: ["a.txt"] }));
    expect(git(join(box, "two"), ["diff", "--cached", "--name-only"])).toBe("a.txt");
    expect(git(join(box, "one"), ["diff", "--cached", "--name-only"])).toBe("");
    expect(events).toEqual([expect.objectContaining({ projectName: "box" })]);
    expect(events[0]!.repo.toLowerCase()).toContain("two");
    expect(asked[0]!.summary.facts.find((f) => f.label === "Repository")!.value).toBe("two");
  });

  it("refuses a project that is not registered without reaching a route", async () => {
    expect((await tool("git_status", { project: "nope" })).isError).toBe(true);
  });
});
