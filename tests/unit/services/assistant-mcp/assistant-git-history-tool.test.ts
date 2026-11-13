/**
 * `git_history` and `git_branch` delete against stand-in routes over a real repository folder
 * (whose hooks the card reads): each action asks once and then calls exactly one write route with
 * the values PPM looked up; every refusal comes before the card; a HEAD, operation or source that
 * moved while the card waited writes nothing; the card names the hooks that will run.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitChanges } from "../../../../src/shared/git-changes.ts";
import type { CallPpmRoute, RouteCallResult } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { noApprover, type ApprovalAsk, type ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { GIT_TOOL_HANDLERS } from "../../../../src/services/assistant-mcp/assistant-git-tools.ts";

const OID = "a".repeat(40);
const DEV = "d".repeat(40);
const PICK = "1234567".padEnd(40, "e");
const MERGED = "9".repeat(40);

let plainRepo = "";
let huskyRepo = "";
beforeAll(() => {
  const init = (dir: string, ...config: string[][]) => {
    for (const args of [["init", "-q", "-b", "main"], ...config]) {
      const p = Bun.spawnSync(["git", ...args], { cwd: dir });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    }
  };
  plainRepo = mkdtempSync(join(tmpdir(), "ppm-git-history-plain-"));
  init(plainRepo);
  huskyRepo = mkdtempSync(join(tmpdir(), "ppm-git-history-husky-"));
  mkdirSync(join(huskyRepo, ".husky"));
  for (const name of ["post-merge", "pre-commit"]) writeFileSync(join(huskyRepo, ".husky", name), "#!/bin/sh\n", { mode: 0o755 });
  init(huskyRepo, ["config", "core.hooksPath", ".husky"]);
});
afterAll(() => {
  rmSync(plainRepo, { recursive: true, force: true });
  rmSync(huskyRepo, { recursive: true, force: true });
});

function changes(over: Partial<GitChanges> = {}): GitChanges {
  return {
    branch: { head: "main", oid: OID, upstream: null, upstreamGone: false, ahead: 0, behind: 0, hasRemote: false },
    operation: null,
    files: [{ path: "new.txt", x: "?", y: "?", untracked: true, conflict: false, staged: null, unstaged: null }],
    stashes: 0,
    lastCommit: { hash: OID, subject: "head subject", author: "T", date: "2026-11-01T00:00:00Z", pushed: false, hasParent: true },
    truncated: false,
    ...over,
  };
}
const ok = (data: unknown): RouteCallResult<unknown> => ({ status: 200, ok: true, data });
const MERGING = changes({ operation: { kind: "merge", name: "dev" } });
const ref = (name: string, type: "branch" | "remote" | "tag", hash: string) => ({
  refName: name, name, type, current: name === "main", hash, shortHash: hash.slice(0, 7), subject: "s", author: "T", date: "d",
  upstream: null, ahead: 0, behind: 0, gone: false,
});
const commit = (hash: string, subject: string, parents: string[] = ["f".repeat(40)]) => ({
  hash, abbreviatedHash: hash.slice(0, 7), subject, body: "", authorName: "T", authorEmail: "t@example.com", authorDate: "d", parents, refs: [],
});

type Answer = RouteCallResult<unknown> | (() => RouteCallResult<unknown>);

function fakeRoutes(answers: Record<string, Answer> = {}, repo = plainRepo) {
  const calls: Array<{ method: string; sub: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
  const defaults: Record<string, Answer> = {
    "GET repos": ok({ root: repo, rootIsRepo: true, repos: [{ path: repo, name: "p", relative: "." }] }),
    "GET changes": ok(changes()),
    "GET refs": ok([ref("main", "branch", OID), ref("dev", "branch", DEV), ref("origin/feature", "remote", "c".repeat(40)), ref("v1", "tag", OID)]),
    "GET graph": ok({ head: OID, branches: [], commits: [commit(OID, "head subject"), commit(PICK, "Fix the parser"), commit(MERGED, "Merge x", [OID, DEV])] }),
  };
  const call: CallPpmRoute = async <T,>(method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(path, "http://x");
    const sub = url.pathname.split("/git/")[1] ?? "";
    calls.push({ method, sub, query: url.searchParams, ...(body ? { body } : {}) });
    const answer = answers[`${method} ${sub}`] ?? defaults[`${method} ${sub}`] ?? ok({});
    return (typeof answer === "function" ? answer() : answer) as RouteCallResult<T>;
  };
  return { call, calls, writes: () => calls.filter((c) => c.method === "POST") };
}

function asker(verdict: ApprovalVerdict = { verdict: "approved" }) {
  const asked: ApprovalAsk[] = [];
  return { asked, ask: async (a: ApprovalAsk) => { asked.push(a); return verdict; } };
}
const ctxOf = (call: CallPpmRoute, ask: ToolContext["ask"]): ToolContext => ({ sessionId: "s-1", ask, callRoute: call });
const text = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const history = (ctx: ToolContext, args: Record<string, unknown>) => GIT_TOOL_HANDLERS.git_history!(ctx, { project: "p", ...args });
const branch = (ctx: ToolContext, args: Record<string, unknown>) => GIT_TOOL_HANDLERS.git_branch!(ctx, { project: "p", ...args });

/** Each action, the state it needs, the write route it must reach and the body it must send. */
const ACTIONS: Array<[Record<string, unknown>, Record<string, Answer>, string, Record<string, unknown>]> = [
  // By full ref, so a tag spelled like the branch cannot be the one merged.
  [{ action: "merge", source: "dev" }, {}, "merge", { source: "refs/heads/dev" }],
  [{ action: "merge", source: "origin/feature" }, {}, "merge", { source: "refs/remotes/origin/feature" }],
  [{ action: "cherry_pick", hash: "1234567" }, {}, "cherry-pick", { hash: PICK }],
  [{ action: "revert", hash: PICK.toUpperCase() }, {}, "revert", { hash: PICK }],
  [{ action: "tag", name: "v2" }, {}, "tag", { name: "v2", hash: OID }],
  [{ action: "tag", name: "v2", at: "1234567" }, {}, "tag", { name: "v2", hash: PICK }],
  [{ action: "abort" }, { "GET changes": ok(MERGING) }, "operation/abort", {}],
  [{ action: "continue" }, { "GET changes": ok(MERGING) }, "operation/continue", {}],
];

describe("git_history", () => {
  it("asks once per action, then calls exactly one write route with the looked-up values", async () => {
    for (const [args, answers, sub, body] of ACTIONS) {
      const { call, writes } = fakeRoutes(answers);
      const { ask, asked } = asker();
      const result = await history(ctxOf(call, ask), args);
      expect({ args, error: result.isError ? text(result) : null }).toEqual({ args, error: null });
      expect({ args, asked: asked.map((a) => a.tool) }).toEqual({ args, asked: ["git_history"] });
      expect({ args, writes: writes().map((w) => [w.sub, w.body]) }).toEqual({ args, writes: [[sub, body]] });
    }
  });

  it("runs nothing when the user declines or nobody can answer", async () => {
    for (const ask of [asker({ verdict: "denied", reason: "no" }).ask, noApprover]) {
      for (const [args, answers] of ACTIONS) {
        const { call, writes } = fakeRoutes(answers);
        const result = await history(ctxOf(call, ask), args);
        expect({ args, isError: result.isError, writes: writes().length }).toEqual({ args, isError: true, writes: 0 });
      }
    }
  });

  it("refuses before asking whatever git would refuse or the card could not name", async () => {
    const conflicted = changes({ files: [{ path: "a.txt", x: "U", y: "U", untracked: false, conflict: true, staged: null, unstaged: null }] });
    const dirty = changes({ files: [{ path: "a.txt", x: ".", y: "M", untracked: false, conflict: false, staged: null, unstaged: { blocks: [], added: 1, removed: 0 } }] });
    const staged = changes({ files: [{ path: "a.txt", x: "M", y: ".", untracked: false, conflict: false, staged: { blocks: [], added: 1, removed: 0 }, unstaged: null }] });
    const detached = changes({ branch: { ...changes().branch, head: null } });
    const conflictedMerge = { ...MERGING, files: conflicted.files };
    const cases: Array<[Record<string, unknown>, Record<string, Answer>?]> = [
      [{ action: "rebase" }],
      [{ action: "merge", source: "dev", hash: PICK }],
      [{ action: "merge", source: "dev" }, { "GET changes": ok(MERGING) }],
      [{ action: "tag", name: "v2" }, { "GET changes": ok(MERGING) }],
      [{ action: "merge", source: "dev" }, { "GET changes": ok(conflicted) }],
      [{ action: "merge", source: "dev" }, { "GET changes": ok(dirty) }],
      [{ action: "cherry_pick", hash: PICK }, { "GET changes": ok(staged) }],
      [{ action: "revert", hash: PICK }, { "GET changes": ok(dirty) }],
      [{ action: "merge", source: "dev" }, { "GET changes": ok(detached) }],
      [{ action: "merge", source: "nowhere" }],
      [{ action: "merge", source: "main" }],
      [{ action: "merge", source: "--no-ff" }],
      [{ action: "cherry_pick", hash: "HEAD~1" }],
      [{ action: "cherry_pick", hash: "abcdef0" }],
      [{ action: "revert", hash: MERGED }],
      [{ action: "tag", name: "-x" }],
      [{ action: "tag", name: "v1" }],
      [{ action: "tag", name: "v2", at: "nothex!" }],
      [{ action: "abort" }],
      [{ action: "continue" }],
      [{ action: "continue" }, { "GET changes": ok(conflictedMerge) }],
    ];
    for (const [args, answers] of cases) {
      const { call, writes } = fakeRoutes(answers);
      const { ask, asked } = asker();
      const result = await history(ctxOf(call, ask), args);
      expect({ args, isError: result.isError, asked: asked.length, writes: writes().length }).toEqual({ args, isError: true, asked: 0, writes: 0 });
    }
  });

  it("aborts with a conflict left, which is what abort is for", async () => {
    const { call, writes } = fakeRoutes({ "GET changes": ok({ ...MERGING, files: [{ path: "a.txt", x: "U", y: "U", untracked: false, conflict: true, staged: null, unstaged: null }] }) });
    await history(ctxOf(call, asker().ask), { action: "abort" });
    expect(writes().map((w) => w.sub)).toEqual(["operation/abort"]);
  });

  it("writes nothing when HEAD, the operation or a merge's source moved while the card waited", async () => {
    const moving = (later: GitChanges) => {
      let reads = 0;
      return () => ok(++reads > 1 ? later : changes());
    };
    const headMoved = fakeRoutes({ "GET changes": moving(changes({ branch: { ...changes().branch, oid: "e".repeat(40) } })) });
    expect(JSON.parse(text(await history(ctxOf(headMoved.call, asker().ask), { action: "cherry_pick", hash: PICK }))).outcome).toBe("stale");
    expect(headMoved.writes()).toHaveLength(0);

    const switched = fakeRoutes({ "GET changes": moving(changes({ branch: { ...changes().branch, head: "dev" } })) });
    expect(JSON.parse(text(await history(ctxOf(switched.call, asker().ask), { action: "tag", name: "v2" }))).outcome).toBe("stale");
    expect(switched.writes()).toHaveLength(0);

    let opReads = 0;
    const opChanged = fakeRoutes({ "GET changes": () => ok(++opReads > 1 ? changes({ operation: { kind: "rebase", step: 1, total: 2 } }) : MERGING) });
    expect(JSON.parse(text(await history(ctxOf(opChanged.call, asker().ask), { action: "continue" }))).outcome).toBe("stale");
    expect(opChanged.writes()).toHaveLength(0);

    let refReads = 0;
    const sourceMoved = fakeRoutes({ "GET refs": () => ok([ref("main", "branch", OID), ref("dev", "branch", ++refReads > 1 ? "b".repeat(40) : DEV)]) });
    expect(JSON.parse(text(await history(ctxOf(sourceMoved.call, asker().ask), { action: "merge", source: "dev" }))).outcome).toBe("stale");
    expect(sourceMoved.writes()).toHaveLength(0);
  });

  it("answers a merge that stopped on a conflict with the files and how to finish", async () => {
    let reads = 0;
    const after = changes({ operation: { kind: "merge", name: "dev" }, files: [{ path: "a.txt", x: "U", y: "U", untracked: false, conflict: true, staged: null, unstaged: null }] });
    const { call } = fakeRoutes({
      "GET changes": () => ok(++reads > 2 ? after : changes()),
      "POST merge": { status: 500, ok: false, error: "CONFLICT (content): Merge conflict in a.txt" },
    });
    const result = await history(ctxOf(call, asker().ask), { action: "merge", source: "dev" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ stopped: true, conflictCount: 1, conflicts: ["a.txt"], operation: { kind: "merge" } });
    expect(text(result)).toContain("git_history with action continue");
  });

  it("builds each card from what PPM read: headline, exact target facts, and the merge's conflict note", async () => {
    const headlines: Record<string, string> = {};
    for (const [args, answers] of ACTIONS) {
      const { call } = fakeRoutes(answers);
      const { ask, asked } = asker();
      await history(ctxOf(call, ask), args);
      const card = asked[0]!.summary;
      headlines[`${args.action}${args.source ? `:${args.source}` : ""}${args.at ? ":at" : ""}`] = card.headline;
      expect(card.facts.slice(0, 4)).toEqual([
        { label: "Project", value: "p" }, { label: "Repository", value: ". (the project folder)" },
        { label: "Branch", value: "main" }, { label: "HEAD at", value: "aaaaaaa" },
      ]);
      if (args.action === "merge") expect(card.facts.find((f) => f.label === "Conflicts")!.value).toBe("Conflicts stop the merge; finish or abort it with git_history");
    }
    expect(headlines).toEqual({
      "merge:dev": "Merge dev into main",
      "merge:origin/feature": "Merge origin/feature into main",
      cherry_pick: 'Copy commit 1234567 "Fix the parser" onto main',
      revert: 'Add a commit undoing 1234567 "Fix the parser" on main',
      tag: 'Tag aaaaaaa "head subject" as v2',
      "tag:at": 'Tag 1234567 "Fix the parser" as v2',
      abort: "Abort the merge — the tree returns to before it started",
      continue: "Continue the merge — creates its commit",
    });
  });

  it("names the repository's hooks on the card when it has some, and says nothing when it has none", async () => {
    const husky = fakeRoutes({}, huskyRepo);
    const withHooks = asker();
    await history(ctxOf(husky.call, withHooks.ask), { action: "merge", source: "dev" });
    expect(withHooks.asked[0]!.summary.facts.find((f) => f.label === "Hooks")).toEqual({
      label: "Hooks", value: "Runs this repository's git hooks: post-merge (.husky)", tone: "warning",
    });
    const pick = asker();
    await history(ctxOf(fakeRoutes({}, huskyRepo).call, pick.ask), { action: "cherry_pick", hash: PICK });
    expect(pick.asked[0]!.summary.facts.find((f) => f.label === "Hooks")!.value).toBe("Runs this repository's git hooks: pre-commit (.husky)");
    const plain = asker();
    await history(ctxOf(fakeRoutes().call, plain.ask), { action: "merge", source: "dev" });
    expect(plain.asked[0]!.summary.facts.find((f) => f.label === "Hooks")).toBeUndefined();
  });
});

describe("git_branch delete", () => {
  it("asks once, re-reads the branch, then deletes it and answers with its last commit", async () => {
    const { call, writes } = fakeRoutes();
    const { ask, asked } = asker();
    const result = await branch(ctxOf(call, ask), { action: "delete", name: "dev" });
    expect(asked.map((a) => a.summary.headline)).toEqual(['Delete the branch dev in "p"']);
    expect(asked[0]!.summary.facts.find((f) => f.label === "Its last commit")!.value).toBe(DEV);
    expect(asked[0]!.summary.warning).toContain("git refuses if its commits are not merged");
    expect(writes().map((w) => [w.sub, w.body])).toEqual([["branch/delete", { name: "dev", force: false }]]);
    expect(JSON.parse(text(result))).toMatchObject({ deleted: "dev", commit: DEV });
  });

  it("warns that a forced delete leaves unmerged commits unreachable", async () => {
    const { call, writes } = fakeRoutes();
    const { ask, asked } = asker();
    await branch(ctxOf(call, ask), { action: "delete", name: "dev", force: true });
    expect(asked[0]!.summary.warning).toContain("its commits not on another branch become unreachable");
    expect(writes()[0]!.body).toEqual({ name: "dev", force: true });
  });

  it("refuses the current branch, an unknown or remote one, and force outside delete, before asking", async () => {
    for (const args of [
      { action: "delete", name: "main" }, { action: "delete", name: "nowhere" }, { action: "delete", name: "origin/feature" },
      { action: "delete", name: "-D" }, { action: "create", name: "x", force: true }, { action: "delete", name: "dev", force: "yes" },
    ]) {
      const { call, writes } = fakeRoutes();
      const { ask, asked } = asker();
      const result = await branch(ctxOf(call, ask), args);
      expect({ args, isError: result.isError, asked: asked.length, writes: writes().length }).toEqual({ args, isError: true, asked: 0, writes: 0 });
    }
  });

  it("deletes nothing when the branch moved while the card waited", async () => {
    let reads = 0;
    const { call, writes } = fakeRoutes({ "GET refs": () => ok([ref("main", "branch", OID), ref("dev", "branch", ++reads > 1 ? "b".repeat(40) : DEV)]) });
    expect(JSON.parse(text(await branch(ctxOf(call, asker().ask), { action: "delete", name: "dev" }))).outcome).toBe("stale");
    expect(writes()).toHaveLength(0);
  });
});
