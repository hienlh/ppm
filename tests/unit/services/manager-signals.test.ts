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
import { createManagerSignals, isTransientStop } from "../../../src/services/assistant-cards/manager-signals.ts";
import type { LateReply } from "../../../src/services/assistant-wake/manager-wake-sources.ts";
import { FAILED_CARD_GRACE_MS } from "../../../src/shared/assistant-limits.ts";

const MGR = "mgr-signals-1";
const CHILD = "child-signals-1";

function harness() {
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
    openRequestCard: findOpenRequestCard,
    reportsSince: (id, kinds, since) => countSessionCardsSince([id], kinds, since),
    lateReply: (r) => late.push(r),
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
  it("mirrors the manager's own approval, never a child chat's, and resolves it when answered in the chat", () => {
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
});
