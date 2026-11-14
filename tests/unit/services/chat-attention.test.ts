/**
 * The overview behind "which chats need me today?": every group filled from live chats, unread
 * marks and the trace; each chat in its most urgent group only; the Assistant's own chats left
 * out; a card's deciding part verbatim but shortened; and the answer still useful without a trace.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  ATTENTION_CARD_BODY_CHARS, ATTENTION_DECIDING_CHARS, ATTENTION_GROUP_MAX, chatsAttention, parseAttentionSince, type AttentionSources,
} from "../../../src/services/assistant-hub/chat-attention.service.ts";
import { setSessionMigratedTo } from "../../../src/services/db.service.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";
import { MAX_TOOL_RESULT_BYTES } from "../../../src/services/assistant-mcp/assistant-tool-output.ts";

const live = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, phase: "idle" as const, running: false, projectName: "web", providerId: "claude", queuedCards: 0, ...extra,
});

function sources(over: Partial<AttentionSources> = {}): AttentionSources {
  return {
    live: () => [],
    unread: () => [],
    turnEnds: () => [],
    meta: (ids) => new Map(ids.map((id) => [id, { project: "web", providerId: "claude", title: `Chat ${id}` }])),
    isAssistant: (id) => id.startsWith("asst"),
    ...over,
  };
}

describe("groups", () => {
  it("puts each chat in its most urgent group, once", () => {
    const r = chatsAttention({ since: 0 }, sources({
      live: () => [
        live("card", { phase: "waiting", running: true, card: { requestId: "r1", tool: "Bash", input: { command: "echo x > ~/.bashrc" }, isQuestion: false }, queuedCards: 1 }),
        live("busy", { phase: "streaming", running: true }),
        live("asst-1", { phase: "streaming", running: true, projectName: "__assistant__" }),
      ],
      unread: () => [
        { sessionId: "card", unreadCount: 1, unreadType: "approval_request", projectName: "web", sessionTitle: null },
        { sessionId: "lost", unreadCount: 1, unreadType: "question", projectName: "api", sessionTitle: "Lost <one>" },
        { sessionId: "fresh", unreadCount: 2, unreadType: "done", projectName: "web", sessionTitle: "Fresh" },
        { sessionId: "err", unreadCount: 1, unreadType: "done", projectName: "web", sessionTitle: null },
      ],
      turnEnds: () => [
        { sessionId: "err", traceId: "err", providerId: "codex", endedAt: 3_000, stop: { message: "Rate limited", at: 3_000 } },
        { sessionId: "fresh", traceId: "fresh", providerId: "claude", endedAt: 2_000 },
        { sessionId: "busy", traceId: "busy", providerId: "claude", endedAt: 1_500 },
        { sessionId: "read", traceId: "read", providerId: "claude", endedAt: 1_000 },
      ],
    }));
    expect(r.needsDecision.map((c) => c.sessionId)).toEqual(["card"]);
    expect(r.needsDecision[0]!.card).toMatchObject({ requestId: "r1", kind: "command", headline: "Bash", deciding: { text: "echo x > ~/.bashrc", complete: true } });
    expect(r.needsDecision[0]!.queuedCards).toBe(1);
    expect(r.running.map((c) => c.sessionId)).toEqual(["busy"]);
    expect(r.lostCards).toEqual([{ sessionId: "lost", project: "api", providerId: "claude", title: "Chat lost", kind: "question" }]);
    expect(r.stopped).toMatchObject([{ sessionId: "err", error: "Rate limited", unread: true, providerId: "codex" }]);
    expect(r.finishedUnread.map((c) => [c.sessionId, c.endedAt])).toEqual([["fresh", new Date(2_000).toISOString()]]);
    expect(r.finishedRead.map((c) => c.sessionId)).toEqual(["read"]);
    expect(JSON.stringify(r)).not.toContain("asst-1");
    expect(r.note).toBeUndefined();
  });

  it("cleans titles but never the deciding part", () => {
    const r = chatsAttention({ since: 0 }, sources({
      meta: () => new Map([["c", { project: "web", providerId: "claude", title: "Fix <script> `now`" }]]),
      live: () => [live("c", { running: true, card: { requestId: "r", tool: "Bash", input: { command: "cat <a >b `c`" }, isQuestion: false } })],
    }));
    expect(r.needsDecision[0]!.title).toBe("Fix script now");
    expect(r.needsDecision[0]!.card.deciding.text).toBe("cat <a >b `c`");
  });

  it("shortens a long deciding part for the overview and says so", () => {
    const content = "y".repeat(ATTENTION_DECIDING_CHARS + 50);
    const r = chatsAttention({ since: 0 }, sources({
      live: () => [live("w", { card: { requestId: "r", tool: "Write", input: { file_path: "/f", content }, isQuestion: false } })],
    }));
    expect(r.needsDecision[0]!.card.deciding).toMatchObject({ shortened: true, complete: true });
    expect(r.needsDecision[0]!.card.deciding.text).toHaveLength(ATTENTION_DECIDING_CHARS + 1);
  });

  it("keeps one project when asked, follows renamed ids, and caps each group", () => {
    setSessionMigratedTo("old-id", "new-id");
    const many = Array.from({ length: ATTENTION_GROUP_MAX + 5 }, (_, i) => live(`run-${i}`, { running: true, phase: "streaming" }));
    const r = chatsAttention({ since: 0, project: "web" }, sources({
      live: () => [...many, live("api-chat", { running: true, projectName: "api" }), live("new-id", { running: true })],
      unread: () => [{ sessionId: "old-id", unreadCount: 1, unreadType: "done", projectName: "web", sessionTitle: null }],
    }));
    expect(r.running).toHaveLength(ATTENTION_GROUP_MAX);
    expect(r.more.running).toBe(6);
    expect(JSON.stringify(r)).not.toContain("api-chat");
    // The unread mark under the old id is the same chat as the running one: listed once.
    expect(r.finishedUnread).toEqual([]);
  });

  it("still answers when the trace cannot be read, and stays within one tool answer", () => {
    const r = chatsAttention({ since: 0 }, sources({
      turnEnds: () => { throw new Error("database is locked"); },
      live: () => Array.from({ length: 30 }, (_, i) => live(`c${i}`, { card: { requestId: `r${i}`, tool: "Write", input: { file_path: "/f", content: "z".repeat(5_000) }, isQuestion: false } })),
    }));
    expect(r.note).toContain("trace could not be read");
    expect(r.needsDecision).toHaveLength(ATTENTION_GROUP_MAX);
    expect(Buffer.byteLength(JSON.stringify(r, null, 1))).toBeLessThan(MAX_TOOL_RESULT_BYTES);
  });
});

describe("since", () => {
  it("reads today and a number of hours, and refuses anything else", () => {
    const now = new Date(2026, 9, 10, 15, 30).getTime();
    expect(parseAttentionSince(undefined, now)).toEqual({ ok: true, value: new Date(2026, 9, 10).getTime() });
    expect(parseAttentionSince("today", now)).toEqual({ ok: true, value: new Date(2026, 9, 10).getTime() });
    expect(parseAttentionSince("6h", now)).toEqual({ ok: true, value: now - 6 * 3_600_000 });
    expect(parseAttentionSince("0h", now).ok).toBe(false);
    expect(parseAttentionSince("yesterday", now).ok).toBe(false);
    expect(parseAttentionSince("500h", now).ok).toBe(false);
  });
});

describe("the Assistant's open cards", () => {
  const openCard = (id: string, over: Partial<AssistantCard> = {}): AssistantCard => ({
    id, kind: "needs_decision", projectName: "ppm", projectKey: "k", sessionId: "mgr-ppm", title: `Card ${id}`, body: "",
    payload: {}, status: "open", answer: null, provenance: null, createdAt: 1_000, updatedAt: 1_000, ...over,
  });

  it("lists every open card first, whatever its age, with what the user needs to find it", () => {
    const r = chatsAttention({ since: 5_000_000 }, sources({
      openCards: () => [
        openCard("a", { okOffered: true, payload: { draft: { to: "#team", text: "hi", sha256: "x".repeat(64) } } }),
        openCard("b", { kind: "approval", projectName: "web", payload: { requestId: "req-9" }, title: "Bash‮ <b>x</b>" }),
        openCard("c", { kind: "budget", projectName: null, sessionId: null }),
      ],
    }));
    expect(r.assistantCards).toEqual([
      { cardId: "a", kind: "needs_decision", project: "ppm", title: "Card a", managerSessionId: "mgr-ppm", createdAt: new Date(1_000).toISOString(), okOffered: true, hasDraft: true },
      { cardId: "b", kind: "approval", project: "web", title: "Bash bx/b", managerSessionId: "mgr-ppm", createdAt: new Date(1_000).toISOString(), okOffered: false, hasDraft: false, requestId: "req-9" },
      { cardId: "c", kind: "budget", project: null, title: "Card c", managerSessionId: null, createdAt: new Date(1_000).toISOString(), okOffered: false, hasDraft: false },
    ]);
    expect(Object.keys(r)[1]).toBe("assistantCards");
  });

  it("keeps one project's cards, shortens a long body, caps the group and says when the cards cannot be read", () => {
    const many = Array.from({ length: ATTENTION_GROUP_MAX + 3 }, (_, i) => openCard(`p${i}`, { body: "x".repeat(ATTENTION_CARD_BODY_CHARS + 50) }));
    const r = chatsAttention({ since: 0, project: "ppm" }, sources({ openCards: () => [openCard("w", { projectName: "web" }), ...many] }));
    expect(r.assistantCards).toHaveLength(ATTENTION_GROUP_MAX);
    expect(r.assistantCards.every((c) => c.project === "ppm")).toBe(true);
    expect(r.more.assistantCards).toBe(3);
    expect(r.assistantCards[0]!.body).toHaveLength(ATTENTION_CARD_BODY_CHARS);
    expect(r.assistantCards[0]!.bodyShortened).toBe(true);

    const broken = chatsAttention({ since: 0 }, sources({ openCards: () => { throw new Error("db"); } }));
    expect(broken.assistantCards).toEqual([]);
    expect(broken.note).toContain("Assistant's cards could not be read");
  });
});
