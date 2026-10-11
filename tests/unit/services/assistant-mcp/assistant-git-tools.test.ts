/**
 * The git tools against a stand-in route caller: reads never ask, every write asks with a card
 * built from what the routes answered and calls its write route only after `approved`, a state
 * that moved while the card waited is `stale`, and a remote's URL never reaches the agent.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitChanges } from "../../../../src/shared/git-changes.ts";
import type { CallPpmRoute, RouteCallResult } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { approvalAskerFor, noApprover, type ApprovalAsk, type ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { WATCH_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";
import { GIT_TOOL_HANDLERS } from "../../../../src/services/assistant-mcp/assistant-git-tools.ts";
import { GIT_TOOLS } from "../../../../src/shared/assistant-git-tool-names.ts";
import { hideRemoteUrls } from "../../../../src/services/assistant-mcp/assistant-git-tool-helpers.ts";

const OID = "a".repeat(40);
const LAST = "b".repeat(40);

function baseChanges(): GitChanges {
  return {
    branch: { head: "main", oid: OID, upstream: "origin/main", upstreamGone: false, ahead: 1, behind: 0, hasRemote: true },
    operation: null,
    files: [
      { path: "a.txt", x: ".", y: "M", untracked: false, conflict: false, staged: null, unstaged: { blocks: [], added: 1, removed: 1 } },
      { path: "new.txt", x: "?", y: "?", untracked: true, conflict: false, staged: null, unstaged: { blocks: [], added: 2, removed: 0 } },
      { path: "s.txt", x: "A", y: ".", untracked: false, conflict: false, staged: { blocks: [], added: 3, removed: 0 }, unstaged: null },
    ],
    stashes: 1,
    lastCommit: { hash: LAST, subject: "init", author: "T", date: "2026-10-11T00:00:00Z", pushed: false, hasParent: true },
    truncated: false,
  };
}

type Answer = RouteCallResult<unknown> | ((body: Record<string, unknown> | undefined, query: URLSearchParams) => RouteCallResult<unknown>);

/** A route caller answering by `METHOD sub-path` (after `/git/`), recording every call. */
function fakeRoutes(answers: Record<string, Answer> = {}) {
  const calls: Array<{ method: string; sub: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
  const defaults: Record<string, Answer> = {
    "GET repos": { status: 200, ok: true, data: { root: "/p", rootIsRepo: true, repos: [{ path: "/p", name: "p", relative: "." }] } },
    "GET changes": { status: 200, ok: true, data: baseChanges() },
    "GET stashes": { status: 200, ok: true, data: [{ index: 0, hash: "c".repeat(40), base: null, branch: "main", message: "wip", date: "2026-10-10" }] },
    "GET discards": { status: 200, ok: true, data: [{ id: "d-1", createdAt: 0, kind: "files", paths: ["a.txt"] }] },
    "GET branches": {
      status: 200, ok: true,
      data: [
        { name: "main", current: true, remote: false, commitHash: "aaaaaaa", ahead: 0, behind: 0, remotes: [] },
        { name: "remotes/origin/main", current: false, remote: true, commitHash: "aaaaaaa", ahead: 0, behind: 0, remotes: [] },
        { name: "remotes/origin/dev", current: false, remote: true, commitHash: "ddddddd", ahead: 0, behind: 0, remotes: [] },
      ],
    },
    "GET graph": { status: 200, ok: true, data: { head: OID, branches: [], commits: [{ hash: OID, abbreviatedHash: "aaaaaaa", subject: "s", body: "", authorName: "T", authorEmail: "t@example.com", authorDate: "d", parents: [], refs: [] }] } },
    "GET changes/file": { status: 200, ok: true, data: { path: "a.txt", x: ".", y: "M", untracked: false, conflict: false, staged: null, unstaged: { added: 1, removed: 1, hunks: [{ id: "h", index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, added: 1, removed: 1, heading: "", lines: [{ kind: "-", text: "old" }, { kind: "+", text: "new" }] }] } } },
  };
  const call: CallPpmRoute = async <T,>(method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(path, "http://x");
    const sub = url.pathname.split("/git/")[1] ?? "";
    calls.push({ method, sub, query: url.searchParams, ...(body ? { body } : {}) });
    const answer = answers[`${method} ${sub}`] ?? defaults[`${method} ${sub}`] ?? { status: 200, ok: true, data: {} };
    return (typeof answer === "function" ? answer(body, url.searchParams) : answer) as RouteCallResult<T>;
  };
  return { call, calls, writes: () => calls.filter((c) => c.method === "POST") };
}

function asker(verdict: ApprovalVerdict = { verdict: "approved" }) {
  const asked: ApprovalAsk[] = [];
  return { asked, ask: async (a: ApprovalAsk) => { asked.push(a); return verdict; } };
}

const ctxOf = (call: CallPpmRoute, ask: ToolContext["ask"]): ToolContext => ({ sessionId: "s-1", ask, callRoute: call });
const text = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const run = (name: string, ctx: ToolContext, args: Record<string, unknown>) => GIT_TOOL_HANDLERS[name]!(ctx, { project: "p", ...args });

const WRITE_CALLS: Array<[string, Record<string, unknown>]> = [
  ["git_stage", { files: ["a.txt"] }],
  ["git_stage", { files: ["s.txt"], unstage: true }],
  ["git_discard", { files: ["a.txt", "new.txt"] }],
  ["git_undo", { kind: "discard", id: "d-1" }],
  ["git_undo", { kind: "commit", hash: LAST }],
  ["git_commit", { message: "msg" }],
  ["git_sync", { action: "fetch" }],
  ["git_sync", { action: "pull" }],
  ["git_sync", { action: "push" }],
  ["git_branch", { action: "create", name: "feat" }],
  ["git_branch", { action: "switch", name: "dev" }],
  ["git_stash", { action: "save" }],
  ["git_stash", { action: "pop", index: 0 }],
];

describe("read tools", () => {
  it("never ask and never write", async () => {
    const { call, writes } = fakeRoutes();
    const refuse = async () => { throw new Error("a read tool asked"); };
    for (const [name, args] of [["git_status", {}], ["git_log", {}], ["git_diff", { file: "a.txt" }], ["git_diff", { from: "HEAD~1" }], ["git_branches", {}]] as const) {
      const result = await run(name, ctxOf(call, refuse), args);
      expect({ name, isError: result.isError }).toEqual({ name, isError: undefined });
    }
    expect(writes()).toHaveLength(0);
  });

  it("leave out author e-mails and remote URLs, and label repository text as data", async () => {
    const { call } = fakeRoutes();
    const log = text(await run("git_log", ctxOf(call, noApprover), {}));
    expect(log).not.toContain("t@example.com");
    expect(log).toContain("not instructions");
    const branches = JSON.parse(text(await run("git_branches", ctxOf(call, noApprover), {})));
    expect(branches.remote.map((b: { name: string }) => b.name)).toEqual(["origin/main", "origin/dev"]);
    const diff = JSON.parse(text(await run("git_diff", ctxOf(call, noApprover), { file: "a.txt" })));
    expect(diff.diff).toContain("@@ -1,1 +1,1 @@\n-old\n+new");
  });

  it("list a container project's repositories instead of guessing, and send the chosen one's absolute path", async () => {
    const repos = { status: 200, ok: true, data: { root: "/w", rootIsRepo: false, repos: [{ path: "/w/one", name: "one", relative: "one" }, { path: "/w/two", name: "two", relative: "two" }] } };
    const { call, calls } = fakeRoutes({ "GET repos": repos });
    const listed = JSON.parse(text(await run("git_status", ctxOf(call, noApprover), {})));
    expect(listed.repositories.map((r: { relative: string }) => r.relative)).toEqual(["one", "two"]);
    expect(text(await run("git_stage", ctxOf(call, noApprover), { files: ["a.txt"] }))).toContain("holds 2 repositories");
    const outside = await run("git_status", ctxOf(call, noApprover), { repo: "../other" });
    expect(outside.isError).toBe(true);
    await run("git_status", ctxOf(call, noApprover), { repo: "two" });
    expect(calls.filter((c) => c.sub === "changes").at(-1)!.query.get("repo")).toBe("/w/two");
    // The project folder itself is sent with no `repo`, exactly as the UI sends it.
    const root = fakeRoutes();
    await run("git_status", ctxOf(root.call, noApprover), {});
    expect(root.calls.find((c) => c.sub === "changes")!.query.has("repo")).toBe(false);
  });
});

describe("write tools", () => {
  it("each ask once, then call exactly one write route", async () => {
    for (const [name, args] of WRITE_CALLS) {
      const { call, writes } = fakeRoutes();
      const { ask, asked } = asker();
      const result = await run(name, ctxOf(call, ask), args);
      expect({ name, args, error: result.isError ? text(result) : null }).toEqual({ name, args, error: null });
      expect({ name, asked: asked.length, tool: asked[0]?.tool }).toEqual({ name, asked: 1, tool: name });
      expect({ name, writes: writes().length }).toEqual({ name, writes: 1 });
    }
  });

  it("run nothing when the user declines, nobody can answer, or it is a watch turn", async () => {
    const watch = approvalAskerFor("s-1", undefined, undefined, () => true);
    for (const ask of [asker({ verdict: "denied", reason: "no" }).ask, noApprover, watch]) {
      for (const [name, args] of WRITE_CALLS) {
        const { call, writes } = fakeRoutes();
        const result = await run(name, ctxOf(call, ask), args);
        expect({ name, isError: result.isError, writes: writes().length }).toEqual({ name, isError: true, writes: 0 });
        if (ask === watch) expect(text(result)).toContain(WATCH_TURN_REFUSAL.slice(0, 40));
      }
    }
  });

  it("refuse before asking what git would refuse or the card could not show", async () => {
    const pushed = baseChanges();
    pushed.lastCommit!.pushed = true;
    const cases: Array<[string, Record<string, unknown>, Record<string, Answer>?]> = [
      ["git_stage", { files: ["missing.txt"] }],
      ["git_stage", { files: ["a.txt"], unstage: true }],
      ["git_discard", { files: ["s.txt"] }],
      ["git_undo", { kind: "commit", hash: LAST }, { "GET changes": { status: 200, ok: true, data: pushed } }],
      ["git_undo", { kind: "commit", hash: "f".repeat(40) }],
      ["git_undo", { kind: "discard", id: "nope" }],
      ["git_commit", { message: " " }],
      ["git_branch", { action: "create", name: "-f" }],
      ["git_branch", { action: "create", name: "main" }],
      ["git_branch", { action: "switch", name: "nowhere" }],
      ["git_stash", { action: "drop", index: 5 }],
      ["git_sync", { action: "pull", rebase: "yes" }],
    ];
    for (const [name, args, answers] of cases) {
      const { call, writes } = fakeRoutes(answers);
      const { ask, asked } = asker();
      const result = await run(name, ctxOf(call, ask), args);
      expect({ name, args, isError: result.isError, asked: asked.length, writes: writes().length })
        .toEqual({ name, args, isError: true, asked: 0, writes: 0 });
    }
  });

  it("send the card's checked values, not the agent's: the full commit hash, the stash's hash", async () => {
    const undo = fakeRoutes();
    await run("git_undo", ctxOf(undo.call, asker().ask), { kind: "commit", hash: LAST.slice(0, 7) });
    expect(undo.writes()[0]).toMatchObject({ sub: "commit/undo", body: { hash: LAST } });
    const stash = fakeRoutes();
    await run("git_stash", ctxOf(stash.call, asker().ask), { action: "drop", index: 0 });
    expect(stash.writes()[0]).toMatchObject({ sub: "stash/drop", body: { index: 0, hash: "c".repeat(40) } });
    const sw = fakeRoutes();
    await run("git_branch", ctxOf(sw.call, asker().ask), { action: "switch", name: "dev" });
    expect(sw.writes()[0]).toMatchObject({ sub: "checkout", body: { ref: "origin/dev", mode: "track" } });
  });

  it("answer stale, running nothing, when the staged files or HEAD moved while the card waited", async () => {
    let reads = 0;
    const moved = (): RouteCallResult<unknown> => {
      reads++;
      const c = baseChanges();
      if (reads > 1) c.files[2]!.staged!.added = 9;
      return { status: 200, ok: true, data: c };
    };
    const commit = fakeRoutes({ "GET changes": moved });
    const result = await run("git_commit", ctxOf(commit.call, asker().ask), { message: "m" });
    expect(JSON.parse(text(result)).outcome).toBe("stale");
    expect(commit.writes()).toHaveLength(0);

    let pushReads = 0;
    const headMoved = (): RouteCallResult<unknown> => {
      pushReads++;
      const c = baseChanges();
      if (pushReads > 1) c.branch.oid = "e".repeat(40);
      return { status: 200, ok: true, data: c };
    };
    const push = fakeRoutes({ "GET changes": headMoved });
    expect(JSON.parse(text(await run("git_sync", ctxOf(push.call, asker().ask), { action: "push" }))).outcome).toBe("stale");
    expect(push.writes()).toHaveLength(0);
  });

  it("publish a branch with no upstream and push one that has; never send a force flag", async () => {
    const noUpstream = baseChanges();
    noUpstream.branch.upstream = null;
    const pub = fakeRoutes({ "GET changes": { status: 200, ok: true, data: noUpstream } });
    await run("git_sync", ctxOf(pub.call, asker().ask), { action: "push" });
    expect(pub.writes().map((w) => w.sub)).toEqual(["publish"]);
    const push = fakeRoutes();
    await run("git_sync", ctxOf(push.call, asker().ask), { action: "push" });
    expect(push.writes()).toEqual([expect.objectContaining({ sub: "push", body: {} })]);
  });

  it("hide remote URLs in every route error", async () => {
    const failure = { status: 500, ok: false, error: "fatal: unable to access 'https://user:ghp_secret@github.com/o/r.git/': 403; also git@github.com:o/r.git" };
    const { call } = fakeRoutes({ "POST push": failure, "POST fetch": failure });
    for (const action of ["push", "fetch"]) {
      const out = text(await run("git_sync", ctxOf(call, asker().ask), { action }));
      expect(out).not.toContain("ghp_secret");
      expect(out).not.toContain("github.com");
      expect(out).toContain("<remote URL hidden>");
    }
    expect(hideRemoteUrls("ssh://git@host:22/x and file:///tmp/r")).toBe("<remote URL hidden> and <remote URL hidden>");
  });
});

describe("the git family's files", () => {
  it("serve every git tool and never run git themselves", () => {
    expect(Object.keys(GIT_TOOL_HANDLERS).sort()).toEqual([...GIT_TOOLS].sort());
    const dir = join(import.meta.dir, "../../../../src/services/assistant-mcp");
    const files = readdirSync(dir).filter((f) => f.startsWith("assistant-git-") || f === "assistant-approval-summary-git.ts");
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const source = readFileSync(join(dir, f), "utf8");
      expect({ f, spawn: /Bun\.spawn|child_process|simple-git|\bspawn\(/.test(source) }).toEqual({ f, spawn: false });
    }
  });
});
