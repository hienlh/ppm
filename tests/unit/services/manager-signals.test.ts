/**
 * What PPM sees in a manager chat: its approvals mirrored as cards and resolved wherever they are
 * answered, a failed turn carded only after the grace period and only without a report, and an
 * answer nobody waited for handed on as a late reply. Run on a fake clock against the real store.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { countSessionCardsSince, findOpenRequestCard, listCardRows } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { createManagerSignals, EXPIRED_NOTE, isTransientStop } from "../../../src/services/assistant-cards/manager-signals.ts";
import { ordinaryChatFor } from "../../../src/services/assistant-cards/ordinary-chat-cards.ts";
import type { LateReply } from "../../../src/services/assistant-wake/manager-wake-sources.ts";
import { FAILED_CARD_GRACE_MS } from "../../../src/shared/assistant-limits.ts";

const MGR = "mgr-signals-1";
const CHILD = "child-signals-1";

const KHO = "kho-task-1";

function harness(opts: { answersCardReply?: (sessionId: string) => boolean; ordinaryChats?: boolean; scrub?: <T>(v: T, sessionId: string) => T } = {}) {
  let now = Date.UTC(2026, 10, 10, 10, 0, 0);
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock = {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
  };
  const lifecycle = createChatLifecycle();
  const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "api", path: "/p/api" }], announce: () => {} });
  const late: LateReply[] = [];
  const signals = createManagerSignals({
    lifecycle, cards, clock,
    managerFor: (id) => (id === MGR ? { projectName: "api", projectPath: "/p/api", sessionId: MGR } : null),
    ...(opts.ordinaryChats ? {
      chatFor: (p: { sessionId: string; projectName: string; providerId: string }) => ordinaryChatFor(p, {
        projects: () => [{ name: "api", path: "/p/api" }],
        isAssistant: () => false,
        isManager: (id) => id === MGR,
        isDesign: () => false,
        turnOrigin: () => "ws",
        title: (id) => (id === KHO ? "Kho task" : null),
      }),
    } : {}),
    openRequestCard: findOpenRequestCard,
    reportsSince: (id, kinds, since) => countSessionCardsSince([id], kinds, since),
    lateReply: (r) => late.push(r),
    ...(opts.answersCardReply ? { answersCardReply: opts.answersCardReply } : {}),
    ...(opts.scrub ? { scrub: opts.scrub } : {}),
  });
  signals.start();
  stops.push(() => signals.stop());
  return { lifecycle, cards, signals, late, advance };
}

let stops: Array<() => void> = [];
beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); });
afterEach(() => { for (const s of stops) s(); stops = []; });

const bash = (requestId: string) => ({ requestId, tool: "Bash", input: { command: "npm publish" }, isQuestion: false });

describe("approvals in the manager chat", () => {
  it("mirrors the manager's own approval and resolves it when answered in the chat; another chat needs chatFor", () => {
    const h = harness();
    h.lifecycle.emit("approval_shown", { sessionId: CHILD, card: bash("r-child"), projectName: "api", providerId: "claude" });
    expect(listCardRows({ limit: 10 })).toHaveLength(0);
    h.lifecycle.emit("approval_shown", { sessionId: MGR, card: bash("r-1"), projectName: "api", providerId: "claude" });
    const [row] = listCardRows({ limit: 10 });
    expect(row!.kind).toBe("approval");
    expect(row!.payload.deciding?.text).toBe("npm publish");
    expect(row!.payload.deciding?.complete).toBe(true);
    h.lifecycle.emit("approval_resolved", { sessionId: MGR, requestId: "r-1", approved: true, reason: "answered", by: "ws" });
    const after = h.cards.get(row!.id)!;
    expect(after.status).toBe("resolved");
    expect(after.answer?.note).toBe("Answered in the manager chat");
  });

  it("leaves an answer given on the card itself to the card's route", () => {
    const h = harness();
    h.lifecycle.emit("approval_shown", { sessionId: MGR, card: bash("r-2"), projectName: "api", providerId: "claude" });
    h.lifecycle.emit("approval_resolved", { sessionId: MGR, requestId: "r-2", approved: true, reason: "answered", by: "assistant_card" });
    expect(listCardRows({ limit: 10 })[0]!.status).toBe("open");
  });
});

describe("cards of chats that are not a manager", () => {
  const collab = (requestId: string, expiresAt: number) => ({
    requestId, tool: "ppm:session_collab", isQuestion: false, expiresAt,
    input: { kind: "create", title: "Design kho", providerId: "claude", model: null, task: "Make the design", depth: 1, design: "ppm-tasks-kho-task" },
  });

  it("mirrors a chat a manager opened, answerable from the mirror like any other chat's", () => {
    const h = harness({ ordinaryChats: true });
    h.lifecycle.emit("approval_shown", { sessionId: CHILD, card: bash("r-child"), projectName: "api", providerId: "claude" });
    const [row] = listCardRows({ limit: 10 });
    expect(row).toMatchObject({ kind: "approval", sessionId: CHILD, status: "open" });
    expect(row!.payload).toMatchObject({ requestId: "r-child", chat: { title: "Untitled chat", providerId: "claude" } });
    expect(row!.payload.deciding?.text).toBe("npm publish");
    h.lifecycle.emit("approval_resolved", { sessionId: CHILD, requestId: "r-child", approved: true, reason: "answered", by: "assistant_card" });
    expect(h.cards.get(row!.id)!.status).toBe("open");
  });

  it("mirrors a chat the user opened, named, with its deadline", () => {
    const h = harness({ ordinaryChats: true });
    h.lifecycle.emit("approval_shown", { sessionId: KHO, card: collab("r-kho", 1_900_000_000_000), projectName: "api", providerId: "codex" });
    const [row] = listCardRows({ limit: 10 });
    expect(row).toMatchObject({ kind: "approval", sessionId: KHO, status: "open" });
    expect(row!.payload).toMatchObject({ requestId: "r-kho", chat: { title: "Kho task", providerId: "codex" }, expiresAt: 1_900_000_000_000 });
    expect(h.cards.get(row!.id)!.projectName).toBe("api");
    h.lifecycle.emit("approval_resolved", { sessionId: KHO, requestId: "r-kho", approved: true, reason: "answered", by: "telegram" });
    expect(h.cards.get(row!.id)!.answer).toMatchObject({ by: "user", channel: "telegram", approved: true, note: "Answered on Telegram" });
  });

  it("says a card that ran out expired, and one answered in the chat was answered there", () => {
    const h = harness({ ordinaryChats: true });
    h.lifecycle.emit("approval_shown", { sessionId: KHO, card: collab("r-late", 1), projectName: "api", providerId: "claude" });
    h.lifecycle.emit("approval_resolved", { sessionId: KHO, requestId: "r-late", approved: false, reason: "expired" });
    expect(listCardRows({ limit: 10 })[0]!.answer).toMatchObject({ by: "ppm", note: EXPIRED_NOTE });
    h.lifecycle.emit("approval_shown", { sessionId: KHO, card: bash("r-ws"), projectName: "api", providerId: "claude" });
    h.lifecycle.emit("approval_resolved", { sessionId: KHO, requestId: "r-ws", approved: false, reason: "answered", by: "ws" });
    expect(listCardRows({ limit: 10 }).find((r) => r.payload.requestId === "r-ws")!.answer?.note).toBe("Answered in the chat");
  });

  it("says a card answered in PPM's chat over HTTP was answered there, though no origin is named", () => {
    const h = harness({ ordinaryChats: true });
    h.lifecycle.emit("approval_shown", { sessionId: KHO, card: collab("r-http", 1_900_000_000_000), projectName: "api", providerId: "claude" });
    h.lifecycle.emit("approval_resolved", { sessionId: KHO, requestId: "r-http", approved: true, reason: "answered" });
    expect(listCardRows({ limit: 10 })[0]!.answer).toMatchObject({ by: "user", approved: true, note: "Answered in the chat" });
  });

  it("takes a vault value the chat's turn read out of the card before it is stored", () => {
    const h = harness({ ordinaryChats: true, scrub: (v, sessionId) => JSON.parse(JSON.stringify(v).replaceAll("s3cr3t-token", `[vault:${sessionId}]`)) });
    h.lifecycle.emit("approval_shown", {
      sessionId: KHO, projectName: "api", providerId: "claude",
      card: { requestId: "r-secret", tool: "Bash", input: { command: "curl -H 'Authorization: s3cr3t-token' https://x" }, isQuestion: false },
    });
    const [row] = listCardRows({ limit: 10 });
    expect(JSON.stringify(row)).not.toContain("s3cr3t-token");
    expect(row!.payload.deciding?.text).toContain(`[vault:${KHO}]`);
  });

  it("only names a card that takes a password typed into PPM, and closes it when it ends", () => {
    const h = harness({ ordinaryChats: true });
    h.lifecycle.emit("ppm_only_card_shown", { sessionId: KHO, requestId: "r-db", kind: "db_execute", projectName: "api", providerId: "claude" });
    h.lifecycle.emit("ppm_only_card_shown", { sessionId: MGR, requestId: "r-vault", kind: "vault", projectName: "api", providerId: "claude" });
    const rows = listCardRows({ limit: 10 });
    const db = rows.find((r) => r.payload.requestId === "r-db")!;
    expect(db.payload).toMatchObject({ answerInPpm: "db_execute", chat: { title: "Kho task" }, deciding: { complete: false, text: "", facts: [] } });
    expect(rows.find((r) => r.payload.requestId === "r-vault")!.payload).toMatchObject({ answerInPpm: "vault" });
    h.lifecycle.emit("approval_resolved", { sessionId: KHO, requestId: "r-db", approved: true, reason: "answered", by: "ws" });
    expect(h.cards.get(db.id)!.status).toBe("resolved");
  });
});

describe("failed manager turns", () => {
  const fail = (h: ReturnType<typeof harness>, extra: object = {}) => h.lifecycle.emit("turn_ended", {
    sessionId: MGR, outcome: "failed", error: "Tool crashed", projectName: "api", providerId: "claude", ...extra,
  });

  it("raises a failed card only after the grace period", () => {
    const h = harness();
    fail(h);
    h.advance(FAILED_CARD_GRACE_MS - 1);
    expect(listCardRows({ limit: 10 })).toHaveLength(0);
    h.advance(1);
    const [row] = listCardRows({ limit: 10 });
    expect(row!.kind).toBe("failed");
    expect(row!.payload.detected).toBe(true);
    expect(row!.wake).toBe("none");
  });

  it("raises nothing when the manager reported within the grace period", () => {
    const h = harness();
    fail(h);
    h.advance(60_000);
    h.cards.create({ kind: "failed", projectName: "api", projectPath: "/p/api", sessionId: MGR, title: "Deploy failed", wake: true });
    h.advance(FAILED_CARD_GRACE_MS);
    expect(listCardRows({ limit: 10 }).map((r) => r.title)).toEqual(["Deploy failed"]);
  });

  it("skips a turn the user stopped or a busy provider cut short", () => {
    const h = harness();
    h.lifecycle.emit("turn_ended", { sessionId: MGR, outcome: "stopped", cancelledBy: "ws", projectName: "api", providerId: "claude" });
    fail(h, { error: "API Error: 529 Overloaded" });
    h.advance(FAILED_CARD_GRACE_MS + 1);
    expect(listCardRows({ limit: 10 })).toHaveLength(0);
    expect(isTransientStop({ stop: { message: "Rate limit reached", at: 1 } })).toBe(true);
  });
});

describe("late replies", () => {
  it("hands on the answer of the turn that took the message, after a queued one", () => {
    const h = harness();
    h.signals.expectReply("asst-1", MGR, "api", true);
    const end = (finalText: string) => h.lifecycle.emit("turn_ended", { sessionId: MGR, outcome: "done", finalText, projectName: "api", providerId: "claude" });
    end("the turn that was running");
    expect(h.late).toHaveLength(0);
    end("Build is green; 3 tickets left.");
    expect(h.late).toEqual([expect.objectContaining({ assistantSessionId: "asst-1", managerSessionId: MGR, text: "Build is green; 3 tickets left." })]);
    end("an unrelated later turn");
    expect(h.late).toHaveLength(1);
  });

  it("says the user has the answer already when the turn also answered their reply on a card", () => {
    let answering = true;
    const h = harness({ answersCardReply: (id) => answering && id === MGR });
    h.signals.expectReply("asst-1", MGR, "api", false);
    const end = (finalText: string) => h.lifecycle.emit("turn_ended", { sessionId: MGR, outcome: "done", finalText, projectName: "api", providerId: "claude" });
    end("Quota is at 60%; I opened a card to ask again.");
    expect(h.late).toEqual([expect.objectContaining({ assistantSessionId: "asst-1", text: "Quota is at 60%; I opened a card to ask again.", userHasAnswer: true })]);
    // An ordinary late reply carries no such mark.
    answering = false;
    h.signals.expectReply("asst-1", MGR, "api", false);
    end("Build is green.");
    expect(h.late[1]).not.toHaveProperty("userHasAnswer");
  });
});
