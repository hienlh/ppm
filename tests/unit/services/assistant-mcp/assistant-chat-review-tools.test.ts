/**
 * The Assistant's review tools: `chat_changes` reads a chat's file changes as the Review tab lists
 * them, and `chat_changes_answer` keeps, reopens, reverts, reverts a turn or undoes. Keep skips its
 * card only in a clean turn; revert, revert_turn and undo always ask; every answer goes with the
 * versions just read, and a file moved since comes back stale.
 */
import { describe, expect, test } from "bun:test";
import { CHAT_ROUTES, createChatToolHandlers } from "../../../../src/services/assistant-mcp/assistant-chat-tools.ts";
import type { ChatToolDeps } from "../../../../src/services/assistant-mcp/assistant-chat-tool-target.ts";
import { CHAT_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-chat-tool-definitions.ts";
import { createRecentUnpins } from "../../../../src/services/assistant-mcp/assistant-recent-unpins.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { CallPpmRoute, RouteCallResult, RouteMethod } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { checkRouteCall, isProjectFamilyPath } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { CHAT_CHANGES_ANSWER_TOOL, CHAT_CHANGES_TOOL } from "../../../../src/shared/assistant-chat-tool-names.ts";
import { UNATTENDED_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";
import type { AssistantProvenance } from "../../../../src/shared/assistant-provenance.ts";
import type { SessionBlockSummary } from "../../../../src/shared/session-file-changes.ts";

const CLEAN: AssistantProvenance = { startedBy: "user_ppm", untrusted: false };
const AFTER_OUTSIDE_TEXT: AssistantProvenance = { startedBy: "user_ppm", untrusted: true, reason: "read" };

interface File { path: string; version: string; additions: number; deletions: number; blocks: SessionBlockSummary[]; reviewed?: boolean }

function harness(opts: { verdict?: ApprovalVerdict; provenance?: AssistantProvenance; onAsk?: (h: H) => void } = {}) {
  const files = new Map<string, File>([
    ["/work/alpha/src/a.ts", { path: "/work/alpha/src/a.ts", version: "v1", additions: 3, deletions: 1, blocks: [
      { key: "4.abc", added: 2, removed: 1, calls: ["toolu_1"] }, { key: "40.def", added: 1, removed: 0, calls: ["toolu_2"] },
    ] }],
    ["/work/alpha/src/b.ts", { path: "/work/alpha/src/b.ts", version: "w1", additions: 1, deletions: 0, blocks: [{ key: "0.ghi", added: 1, removed: 0, calls: ["toolu_2"] }] }],
  ]);
  const turns = [
    { n: 1, at: "2026-11-13T05:01:00Z", prompt: "add the flag", calls: ["toolu_1"] },
    { n: 2, at: "2026-11-13T05:02:00Z", prompt: "test it", calls: ["toolu_2"] },
  ];
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const asks: ApprovalAsk[] = [];
  const written: string[] = [];
  let unattended = false;

  const callRoute = (async <T,>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    const checked = checkRouteCall(CHAT_ROUTES, method, path, body, () => null);
    if (!checked.ok || !isProjectFamilyPath(path.split("?")[0]!)) throw new Error(`not allowed: ${method} ${path}`);
    const [route, query] = path.split("?") as [string, string | undefined];
    const tail = route.split("/file-changes")[1] ?? "";
    const data = (v: unknown) => ({ status: 200, ok: true, data: v as T });
    if (method === "GET" && tail === "/turns") return data({ turns, total: turns.length, paths: [...files.keys()] });
    if (method === "GET" && tail === "/diff") {
      const p = new URLSearchParams(query).get("path")!;
      return data({ ...files.get(p), status: "modified", baseline: "session", original: "one\ntwo\nthree\n", modified: "one\nTWO\nthree\nfour\n" });
    }
    posts.push({ path: tail, body: body ?? {} });
    if (tail === "") return data({ files: [...files.values()].map((f) => ({ ...f, status: "modified", baseline: "session" })) });
    if (tail === "/answer") {
      const out = (body!.files as Array<{ path: string; version: string }>).map((f) =>
        files.get(f.path)!.version === f.version ? { path: f.path, file: null } : { path: f.path, stale: true, file: null });
      return data({ files: out, ...(out.some((f) => !f.stale) ? { undoId: "11111111-1111-1111-1111-111111111111" } : {}) });
    }
    if (tail === "/revert-turn") {
      const preview = [...files.values()].filter((f) => f.blocks.some((b) => (body!.calls as string[]).some((c) => b.calls?.includes(c))))
        .map((f) => ({ path: f.path, version: f.version, action: "edit", changes: 1, added: 1, removed: 0, skipped: [] }));
      if (!body!.apply) return data({ files: preview });
      const stale = (body!.apply as Array<{ path: string; version: string }>).some((a) => files.get(a.path)!.version !== a.version);
      if (stale) return data({ files: preview, stale: true });
      for (const a of body!.apply as Array<{ path: string }>) written.push(a.path);
      return data({ files: preview, undoId: "22222222-2222-2222-2222-222222222222" });
    }
    if (tail === "/undo") return data({ files: [{ path: "/work/alpha/src/a.ts", file: null }] });
    throw new Error(`unexpected ${method} ${path}`);
  }) as CallPpmRoute;

  const deps: ChatToolDeps = {
    projects: () => [{ name: "alpha", path: "/work/alpha" }],
    target: (_project, sessionId) => (sessionId === "c1" ? { ok: true, value: { sessionId: "c1", providerId: "claude" } } : { ok: false, error: "not a chat" }),
    facts: async () => ({ title: "Fix the login bug", pinned: false, tag: null, manager: false, branched: false }),
    control: () => null,
    backgroundWork: async () => false,
    unattended: () => unattended,
    unpins: createRecentUnpins(),
    now: () => 0,
    undoRecord: (_s, id) => (id === "11111111-1111-1111-1111-111111111111"
      ? { createdAt: "2026-11-13T05:10:00Z", files: [{ path: "/work/alpha/src/a.ts", wroteFile: true }] } : null),
  };
  const h = {
    files, posts, asks, written, deps,
    setUnattended: (v: boolean) => { unattended = v; },
    ctx: {
      sessionId: "assistant-session", callRoute,
      ...(opts.provenance ? { provenanceAtCall: opts.provenance } : {}),
      ask: async (ask: ApprovalAsk) => {
        asks.push(ask);
        opts.onAsk?.(h);
        return opts.verdict ?? { verdict: "approved" as const };
      },
    } as ToolContext,
  };
  return h;
}
type H = ReturnType<typeof harness>;

const run = (h: H, tool: string, args: Record<string, unknown>) => createChatToolHandlers(h.deps)[tool]!(h.ctx, { project: "alpha", sessionId: "c1", ...args });
const out = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const json = (r: Record<string, unknown>) => JSON.parse(out(r));
const answerAction = (h: H) => (tool: string, args: Record<string, unknown>) => run(h, tool, args);

test("chat_changes reads only; chat_changes_answer is destructive", () => {
  const by = (name: string) => CHAT_TOOL_DEFINITIONS.find((d) => d.name === name)!.annotations;
  expect(by(CHAT_CHANGES_TOOL)).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  expect(by(CHAT_CHANGES_ANSWER_TOOL)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
});

describe("chat_changes", () => {
  test("lists the files with their open blocks and the turns, asking for the transcript's paths", async () => {
    const h = harness();
    const r = json(await run(h, CHAT_CHANGES_TOOL, {}));
    expect(r.files.map((f: { path: string; openBlocks: number }) => [f.path, f.openBlocks])).toEqual([["/work/alpha/src/a.ts", 2], ["/work/alpha/src/b.ts", 1]]);
    expect(r.turns).toEqual([{ n: 1, at: "2026-11-13T05:01:00Z", prompt: "add the flag", calls: 1 }, { n: 2, at: "2026-11-13T05:02:00Z", prompt: "test it", calls: 1 }]);
    expect(h.posts[0]!.body).toEqual({ paths: ["/work/alpha/src/a.ts", "/work/alpha/src/b.ts"] });
  });

  test("with a path: that file's blocks with their lines, and a unified diff", async () => {
    const r = json(await run(harness(), CHAT_CHANGES_TOOL, { path: "src/a.ts" }));
    expect(r.path).toBe("/work/alpha/src/a.ts");
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatchObject({ lines: "1-4", added: 2, removed: 1 });
    expect(r.diff).toContain("-two\n+TWO");
  });

  test("refuses a path that is not among the chat's changes", async () => {
    const r = await run(harness(), CHAT_CHANGES_TOOL, { path: "/etc/passwd" });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("not among this chat's changed files");
  });
});

describe("chat_changes_answer keep and reopen", () => {
  test("keeps without a card in a clean turn, at the versions just listed", async () => {
    const h = harness({ provenance: CLEAN });
    const r = json(await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "keep", files: [{ path: "src/a.ts", blocks: ["4.abc"] }] }));
    expect(h.asks).toHaveLength(0);
    expect(r).toMatchObject({ outcome: "kept", undoId: expect.any(String) });
    expect(h.posts.at(-1)).toEqual({ path: "/answer", body: { answer: "keep", files: [{ path: "/work/alpha/src/a.ts", version: "v1", keys: ["4.abc"] }] } });
  });

  test("after outside text reached the turn, one batched card for every file", async () => {
    const h = harness({ provenance: AFTER_OUTSIDE_TEXT });
    await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "keep" });
    expect(h.asks).toHaveLength(1);
    const card = h.asks[0]!.summary!;
    expect(card.headline).toBe('Keep 2 files as chat "Fix the login bug" changed them');
    expect(card.facts.filter((f) => f.label === "File").map((f) => f.value)).toEqual(["/work/alpha/src/a.ts (+3 −1)", "/work/alpha/src/b.ts (+1 −0)"]);
    expect((h.posts.at(-1)!.body.files as unknown[]).length).toBe(2);
  });

  test("an unknown provenance is not clean", async () => {
    const h = harness();
    await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "keep", files: [{ path: "src/b.ts" }] });
    expect(h.asks).toHaveLength(1);
  });

  test("refused in a turn PPM started on its own, before anything is read", async () => {
    const h = harness({ provenance: CLEAN });
    h.setUnattended(true);
    const r = await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "keep" });
    expect(out(r)).toBe(UNATTENDED_TURN_REFUSAL);
    expect(h.posts).toHaveLength(0);
  });

  test("reopen needs no card", async () => {
    const h = harness({ provenance: AFTER_OUTSIDE_TEXT });
    const r = json(await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "reopen", files: [{ path: "src/a.ts" }] }));
    expect(h.asks).toHaveLength(0);
    expect(r.outcome).toBe("reopened");
    expect(h.posts.at(-1)!.body.answer).toBe("open");
  });

  test("refuses a block the file does not have", async () => {
    const r = await run(harness({ provenance: CLEAN }), CHAT_CHANGES_ANSWER_TOOL, { action: "keep", files: [{ path: "src/a.ts", blocks: ["9.zzz"] }] });
    expect(r.isError).toBe(true);
  });
});

describe("chat_changes_answer revert", () => {
  test("asks with every path whole, then answers at the versions the card showed", async () => {
    const h = harness({ provenance: CLEAN });
    const r = json(await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert", files: [{ path: "src/a.ts" }] }));
    const card = h.asks[0]!.summary!;
    expect(card.headline).toBe('Put back 1 file as they were before chat "Fix the login bug" changed them');
    expect(card.warning).toBe("Changes the files on disk; undo is available afterwards from this chat's review.");
    expect(r).toMatchObject({ outcome: "reverted", undoId: expect.any(String) });
  });

  test("a file moved while the card waited comes back stale, as the route answers it", async () => {
    const h = harness({ onAsk: (x) => { x.files.get("/work/alpha/src/a.ts")!.version = "v2"; } });
    const r = json(await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert", files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }));
    expect(h.posts.at(-1)!.body.files).toEqual([{ path: "/work/alpha/src/a.ts", version: "v1" }, { path: "/work/alpha/src/b.ts", version: "w1" }]);
    expect(r.files).toEqual([{ path: "/work/alpha/src/a.ts", stale: true }, { path: "/work/alpha/src/b.ts" }]);
    expect(r.note).toContain("changed since");
  });

  test("needs files", async () => {
    const h = harness();
    expect((await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert" })).isError).toBe(true);
    expect(h.asks).toHaveLength(0);
  });
});

describe("chat_changes_answer revert_turn", () => {
  test("previews, asks with the preview, then applies exactly the preview's versions", async () => {
    const h = harness({ provenance: CLEAN });
    const r = json(await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert_turn", turn: 2 }));
    const reverts = h.posts.filter((p) => p.path === "/revert-turn");
    expect(reverts[0]!.body).toEqual({ calls: ["toolu_2"] });
    expect(reverts[1]!.body).toEqual({ calls: ["toolu_2"], apply: [{ path: "/work/alpha/src/a.ts", version: "v1" }, { path: "/work/alpha/src/b.ts", version: "w1" }] });
    expect(h.asks[0]!.summary!.headline).toBe('Put back what turn 2 of chat "Fix the login bug" changed in 2 files');
    expect(r).toMatchObject({ outcome: "reverted", turn: 2, undoId: expect.any(String) });
    expect(h.written).toEqual(["/work/alpha/src/a.ts", "/work/alpha/src/b.ts"]);
  });

  test("a file touched between preview and approval: nothing is written and the answer is stale", async () => {
    const h = harness({ onAsk: (x) => { x.files.get("/work/alpha/src/b.ts")!.version = "w2"; } });
    const r = await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert_turn", turn: 2 });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("stale");
    expect(h.written).toEqual([]);
  });

  test("an unknown turn is refused before anything is previewed or asked", async () => {
    const h = harness();
    const r = await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "revert_turn", turn: 7 });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("no turn 7");
    expect(h.posts).toHaveLength(0);
    expect(h.asks).toHaveLength(0);
  });
});

describe("chat_changes_answer undo", () => {
  test("names the answer's files from its journal, then undoes it", async () => {
    const h = harness({ provenance: CLEAN });
    const r = json(await answerAction(h)(CHAT_CHANGES_ANSWER_TOOL, { action: "undo", undoId: "11111111-1111-1111-1111-111111111111" }));
    const card = h.asks[0]!.summary!;
    expect(card.facts.map((f) => f.value)).toContain("/work/alpha/src/a.ts (written back on disk)");
    expect(card.warning).toContain("Changes the files on disk");
    expect(h.posts.at(-1)).toEqual({ path: "/undo", body: { undoId: "11111111-1111-1111-1111-111111111111" } });
    expect(r.outcome).toBe("undone");
  });

  test("an undoId the chat's journal does not hold is refused without asking", async () => {
    const h = harness();
    const r = await run(h, CHAT_CHANGES_ANSWER_TOOL, { action: "undo", undoId: "33333333-3333-3333-3333-333333333333" });
    expect(r.isError).toBe(true);
    expect(h.asks).toHaveLength(0);
  });
});
