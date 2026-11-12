/**
 * The Assistant's chat tools: stop a running turn, organise chats (rename, pin, tag, read) and
 * delete one. Stop and delete always ask; organise skips its card only in a clean turn and is
 * refused in a turn PPM started on its own. Every card is built from PPM's records, and nothing
 * runs when the chat changed while the card waited.
 */
import { describe, expect, test } from "bun:test";
import { CHAT_ROUTES, createChatToolHandlers } from "../../../../src/services/assistant-mcp/assistant-chat-tools.ts";
import type { ChatFacts, ChatToolDeps } from "../../../../src/services/assistant-mcp/assistant-chat-tool-target.ts";
import { CHAT_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-chat-tool-definitions.ts";
import { createRecentUnpins } from "../../../../src/services/assistant-mcp/assistant-recent-unpins.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { CallPpmRoute, RouteCallResult, RouteMethod } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { checkRouteCall, isProjectFamilyPath, ruleProblem } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { CHAT_DELETE_TOOL, CHAT_ORGANIZE_TOOL, CHAT_STOP_TOOL, CHAT_TOOLS } from "../../../../src/shared/assistant-chat-tool-names.ts";
import type { ChatControl, LiveChatState } from "../../../../src/services/chat-control/chat-control.ts";
import { UNATTENDED_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";
import type { AssistantProvenance } from "../../../../src/shared/assistant-provenance.ts";

type Chat = { project: string; facts: ChatFacts };
/** What a test may change while a card waits. */
interface Records { chats: Map<string, Chat>; live: Map<string, LiveChatState> }

const CLEAN: AssistantProvenance = { startedBy: "user_ppm", untrusted: false };
const AFTER_OUTSIDE_TEXT: AssistantProvenance = { startedBy: "user_ppm", untrusted: true, reason: "read" };

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  title: "Fix the login bug", pinned: false, tag: null, manager: false, branched: false, ...over,
});

function harness(opts: { verdict?: ApprovalVerdict; onAsk?: (r: Records) => void; provenance?: AssistantProvenance } = {}) {
  const chats = new Map<string, Chat>([
    ["c1", { project: "alpha", facts: facts() }],
    ["c2", { project: "alpha", facts: facts({ title: "Release notes" }) }],
    ["c3", { project: "beta", facts: facts({ title: "Other project" }) }],
  ]);
  const live = new Map<string, LiveChatState>();
  const writes: string[] = [];
  const asks: ApprovalAsk[] = [];
  const cancelled: Array<[string, string]> = [];
  const tags = [{ id: 1, name: "Bugs" }, { id: 2, name: "Ideas" }];
  let clock = Date.parse("2026-11-13T05:00:00Z");
  let deleteAnswer: RouteCallResult | null = null;

  // A stand-in for the chat routes, behind the family's real allowlist and the router's real gate.
  const callRoute = (async <T,>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    const checked = checkRouteCall(CHAT_ROUTES, method, path, body, () => null);
    if (!checked.ok || !isProjectFamilyPath(path.split("?")[0]!)) throw new Error(`not allowed: ${method} ${path}`);
    if (method === "GET") return { status: 200, ok: true, data: { tags, counts: {}, defaultTagId: null } as T };
    writes.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    const [, , , , , , id, mark] = path.split("?")[0]!.split("/");
    const chat = chats.get(id!)!;
    if (method === "DELETE" && !mark) {
      if (deleteAnswer) return deleteAnswer as RouteCallResult<T>;
      chats.delete(id!);
    } else if (mark === "pin") chat.facts.pinned = method === "PUT";
    else if (mark === "tag") chat.facts.tag = method === "DELETE" ? null : tags.find((t) => t.id === body!.tagId)!;
    else if (!mark) chat.facts.title = body!.title as string;
    return { status: 200, ok: true, data: {} as T };
  }) as CallPpmRoute;

  const control: ChatControl = {
    sendUserMessage: async () => ({ ok: false, error: "unused" }),
    answerApproval: () => "stale",
    cancelTurn: (id, origin) => { cancelled.push([id, origin]); return live.has(id); },
    liveState: (id) => (live.has(id) ? { ...live.get(id)! } : null),
    listLive: () => [],
  };
  const background = new Set<string>();
  let unattended = false;
  const deps: ChatToolDeps = {
    projects: () => [{ name: "alpha", path: "/work/alpha" }, { name: "beta", path: "/work/beta" }],
    target: (project, sessionId) => {
      if (sessionId === "assistant-1") return { ok: false, error: "That is a PPM Assistant chat, not one of the project's chats." };
      const chat = typeof sessionId === "string" ? chats.get(sessionId) : undefined;
      return chat && chat.project === project.name
        ? { ok: true, value: { sessionId: sessionId as string, providerId: "claude" } }
        : { ok: false, error: `Session ${String(sessionId)} is not a chat of project "${project.name}".` };
    },
    facts: async (id) => structuredClone(chats.get(id)!.facts),
    control: () => control,
    backgroundWork: async (id) => background.has(id),
    unattended: () => unattended,
    unpins: createRecentUnpins(),
    now: () => clock,
    undoRecord: () => null,
  };
  const h = {
    chats, live, writes, asks, cancelled, background, deps,
    setUnattended: (v: boolean) => { unattended = v; },
    advance: (ms: number) => { clock += ms; },
    answerDeleteWith: (r: RouteCallResult) => { deleteAnswer = r; },
    ctx: {
      sessionId: "assistant-session",
      callRoute,
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
const run = (h: H, tool: string, args: Record<string, unknown>) => createChatToolHandlers(h.deps)[tool]!(h.ctx, args);
const textOf = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const running = (turnId: string, since = 1_700_000_000_000): LiveChatState => ({
  phase: "streaming", running: true, projectName: "alpha", providerId: "claude", queuedCards: 0, turnId, runningSince: since,
});

test("names, definitions, handlers and routes line up; stop and delete are destructive, organise is not", () => {
  expect(CHAT_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...CHAT_TOOLS]);
  expect(Object.keys(createChatToolHandlers())).toEqual([...CHAT_TOOLS]);
  expect(CHAT_ROUTES.map(ruleProblem)).toEqual(CHAT_ROUTES.map(() => null));
  const by = (name: string) => CHAT_TOOL_DEFINITIONS.find((d) => d.name === name)!.annotations;
  expect(by(CHAT_STOP_TOOL)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  expect(by(CHAT_DELETE_TOOL)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  expect(by(CHAT_ORGANIZE_TOOL)).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
});

describe("chat_stop", () => {
  test("asks with a card from PPM's records, then stops the turn as the Assistant", async () => {
    const h = harness();
    h.live.set("c1", running("t1"));
    h.background.add("c1");
    const res = await run(h, CHAT_STOP_TOOL, { project: "alpha", sessionId: "c1" });
    expect(JSON.parse(textOf(res))).toMatchObject({ outcome: "stopped", sessionId: "c1" });
    const card = h.asks[0]!.summary;
    expect(card.headline).toBe('Stop the running turn in "Fix the login bug"');
    expect(card.facts).toEqual(expect.arrayContaining([
      { label: "Project", value: "alpha" }, { label: "Chat", value: "Fix the login bug (c1)" }, { label: "Provider", value: "Claude" },
      { label: "Running since", value: new Date(1_700_000_000_000).toISOString() },
    ]));
    expect(card.warning).toBe("What it already wrote stays; work in progress stops. Its background agents and shells stop too.");
    expect(h.cancelled).toEqual([["c1", "assistant"]]);
  });

  test("refuses, before asking, a chat that is not running, the Assistant's own chat and another project's chat", async () => {
    const h = harness();
    expect(textOf(await run(h, CHAT_STOP_TOOL, { project: "alpha", sessionId: "c1" }))).toContain("not running a turn");
    expect(textOf(await run(h, CHAT_STOP_TOOL, { project: "alpha", sessionId: "assistant-1" }))).toContain("PPM Assistant chat");
    expect(textOf(await run(h, CHAT_STOP_TOOL, { project: "alpha", sessionId: "c3" }))).toContain("not a chat of project");
    expect(h.asks).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  test("stops nothing when the turn the card showed ended and another began while it waited", async () => {
    const h = harness({ onAsk: (x) => { x.live.set("c1", running("t2", 1_700_000_100_000)); } });
    h.live.set("c1", running("t1"));
    const res = await run(h, CHAT_STOP_TOOL, { project: "alpha", sessionId: "c1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("stale");
    expect(h.cancelled).toEqual([]);
  });
});

describe("chat_organize", () => {
  test("runs without a card in a clean turn, through the chat routes", async () => {
    const h = harness({ provenance: CLEAN });
    const res = await run(h, CHAT_ORGANIZE_TOOL, {
      project: "alpha", changes: [{ sessionId: "c1", title: "Login bug", pinned: true, tag: "bugs", read: true }],
    });
    expect(h.asks).toEqual([]);
    expect(JSON.parse(textOf(res))).toMatchObject({
      outcome: "changed",
      chats: [{ sessionId: "c1", changed: { title: "Login bug", pinned: true, tag: "Bugs", read: true }, previous: { title: "Fix the login bug", pinned: false, tag: null } }],
    });
    expect(h.writes).toEqual([
      'PATCH /api/project/alpha/chat/sessions/c1 {"title":"Login bug"}',
      "PUT /api/project/alpha/chat/sessions/c1/pin",
      'PATCH /api/project/alpha/chat/sessions/c1/tag {"tagId":1}',
      "POST /api/project/alpha/chat/sessions/c1/read",
    ]);
  });

  test("asks once for the whole call after outside text reached the turn, or when the turn's start is unknown", async () => {
    for (const provenance of [AFTER_OUTSIDE_TEXT, undefined, { startedBy: "ppm", untrusted: false } as AssistantProvenance]) {
      const h = harness(provenance ? { provenance } : {});
      h.chats.get("c2")!.facts.pinned = true;
      await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", read: true }, { sessionId: "c2", pinned: false, title: "Notes «v2»" }] });
      expect(h.asks).toHaveLength(1);
      const card = h.asks[0]!.summary;
      expect(card.headline).toBe('Change 2 chats in "alpha"');
      expect(card.facts).toEqual([
        { label: "Fix the login bug", value: "mark read (c1)" },
        { label: "Release notes", value: "rename → «Notes «v2»», unpin (c2)", tone: "warning" },
      ]);
      expect(h.writes).toHaveLength(3);
    }
  });

  test("never changes anything without a card when the turn was untrusted, and nothing on a decline", async () => {
    const h = harness({ provenance: AFTER_OUTSIDE_TEXT, verdict: { verdict: "denied", reason: "no" } });
    const res = await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", title: "Injected title" }] });
    expect(JSON.parse(textOf(res)).outcome).toBe("declined");
    expect(h.asks).toHaveLength(1);
    expect(h.writes).toEqual([]);
  });

  test("is refused in a turn PPM started on its own, before anything is read or asked", async () => {
    const h = harness({ provenance: CLEAN });
    h.setUnattended(true);
    const res = await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", read: true }] });
    expect(textOf(res)).toBe(UNATTENDED_TURN_REFUSAL);
    expect(h.asks).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("refuses to mark read a chat waiting on a card, and a manager chat's new title", async () => {
    const h = harness({ provenance: CLEAN });
    h.live.set("c1", { ...running("t1"), card: { requestId: "r1", tool: "Bash", input: {}, isQuestion: false } });
    expect(textOf(await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", read: true }] }))).toContain("waiting for the user to answer a card");
    // Marking it unread, or pinning it, is still fine.
    expect((await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", pinned: true }] })).isError).toBeUndefined();
    h.chats.get("c2")!.facts.manager = true;
    expect(textOf(await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c2", title: "x" }] }))).toContain("manager chat");
    expect(h.writes).toEqual(["PUT /api/project/alpha/chat/sessions/c1/pin"]);
  });

  test("checks the list: size, duplicates, empty entries, unknown fields and tags", async () => {
    const h = harness({ provenance: CLEAN });
    const bad = async (changes: unknown) => textOf(await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes }));
    expect(await bad([])).toContain("1-20");
    expect(await bad(Array.from({ length: 21 }, (_, i) => ({ sessionId: `c${i}`, read: true })))).toContain("1-20");
    expect(await bad([{ sessionId: "c1", read: true }, { sessionId: "c1", pinned: true }])).toContain("already in the list");
    expect(await bad([{ sessionId: "c1" }])).toContain("changes nothing");
    expect(await bad([{ sessionId: "c1", colour: "red" }])).toContain('unknown field "colour"');
    expect(await bad([{ sessionId: "c1", title: "a\nb" }])).toContain("one line");
    expect(await bad([{ sessionId: "c1", tag: "Urgent" }])).toContain("its tags are: Bugs, Ideas");
    expect(await bad([{ sessionId: "c3", read: true }])).toContain("not a chat of project");
    expect(h.writes).toEqual([]);
  });

  test("changes nothing when a chat changed while the card waited", async () => {
    const h = harness({ provenance: AFTER_OUTSIDE_TEXT, onAsk: (x) => { x.chats.get("c2")!.facts.title = "Renamed elsewhere"; } });
    const res = await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", pinned: true }, { sessionId: "c2", title: "Renamed elsewhere" }] });
    expect(textOf(res)).toContain("changed while the card waited");
    const h2 = harness({ provenance: AFTER_OUTSIDE_TEXT, onAsk: (x) => { x.chats.get("c1")!.facts.pinned = true; } });
    const stale = await run(h2, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", pinned: true }] });
    expect(textOf(stale)).toContain("changed while the card waited");
    expect([...h.writes, ...h2.writes]).toEqual([]);
    const h3 = harness({ provenance: AFTER_OUTSIDE_TEXT, onAsk: (x) => { x.live.set("c1", { ...running("t1"), card: { requestId: "r", tool: "Bash", input: {}, isQuestion: false } }); } });
    expect(textOf(await run(h3, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", read: true }] }))).toContain("Nothing changed");
    expect(h3.writes).toEqual([]);
  });
});

describe("chat_delete", () => {
  test("says on the card that the chat is pinned, and deletes through the route with the stored provider", async () => {
    const h = harness();
    h.chats.get("c1")!.facts.pinned = true;
    const res = await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" });
    expect(JSON.parse(textOf(res))).toMatchObject({ outcome: "deleted", sessionId: "c1" });
    const card = h.asks[0]!.summary;
    expect(card.headline).toBe('Delete the chat "Fix the login bug"');
    expect(card.facts).toEqual(expect.arrayContaining([{ label: "Pinned", value: "Yes", tone: "warning" }]));
    expect(card.warning).toBe("The transcript and PPM's records of this chat are deleted. This cannot be undone.");
    expect(h.writes).toEqual(["DELETE /api/project/alpha/chat/sessions/c1?stopRunning=1&providerId=claude"]);
  });

  test("says when the Assistant itself took the pin off within the day", async () => {
    const h = harness({ provenance: CLEAN });
    h.chats.get("c1")!.facts.pinned = true;
    await run(h, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", pinned: false }] });
    const unpinnedAt = new Date(h.deps.now()).toISOString();
    h.advance(60 * 60 * 1000);
    await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" });
    expect(h.asks[0]!.summary.facts).toEqual(expect.arrayContaining([
      { label: "Pinned", value: `Until ${unpinnedAt} (unpinned by the Assistant)`, tone: "warning" },
    ]));
    // A day later the record is gone, and an unpinned chat says nothing about pins.
    const later = harness({ provenance: CLEAN });
    later.chats.get("c1")!.facts.pinned = true;
    await run(later, CHAT_ORGANIZE_TOOL, { project: "alpha", changes: [{ sessionId: "c1", pinned: false }] });
    later.advance(25 * 60 * 60 * 1000);
    await run(later, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" });
    expect(later.asks[0]!.summary.facts.some((f) => f.label === "Pinned")).toBe(false);
  });

  test("a running chat is stopped first: the card says so and the route is asked to stop it", async () => {
    const h = harness();
    h.live.set("c1", running("t1"));
    await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" });
    expect(h.asks[0]!.summary.facts).toEqual(expect.arrayContaining([{ label: "Running now", value: "It is stopped first", tone: "warning" }]));
    expect(h.writes).toEqual(["DELETE /api/project/alpha/chat/sessions/c1?stopRunning=1&providerId=claude"]);
  });

  test("passes the route's refusal through when the turn would not stop", async () => {
    const h = harness();
    h.answerDeleteWith({ status: 409, ok: false, error: "The turn did not stop, so the chat was not deleted" });
    const res = await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" });
    expect(textOf(res)).toBe("Not deleted (PPM answered 409): The turn did not stop, so the chat was not deleted");
    expect(h.chats.has("c1")).toBe(true);
  });

  test("refuses, before asking, a manager chat, a branched chat and the Assistant's own chat", async () => {
    const h = harness();
    h.chats.get("c1")!.facts.manager = true;
    h.chats.get("c2")!.facts.branched = true;
    expect(textOf(await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" }))).toContain("manager chat");
    expect(textOf(await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c2" }))).toContain("branched");
    expect(textOf(await run(h, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "assistant-1" }))).toContain("PPM Assistant chat");
    expect(h.asks).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("deletes nothing when the chat was pinned, or started a turn, while the card waited", async () => {
    const pinned = harness({ onAsk: (x) => { x.chats.get("c1")!.facts.pinned = true; } });
    expect(textOf(await run(pinned, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" }))).toContain("was pinned while the card waited");
    const started = harness({ onAsk: (x) => { x.live.set("c1", running("t9")); } });
    expect(textOf(await run(started, CHAT_DELETE_TOOL, { project: "alpha", sessionId: "c1" }))).toContain("started a turn while the card waited");
    expect([...pinned.writes, ...started.writes]).toEqual([]);
  });
});
