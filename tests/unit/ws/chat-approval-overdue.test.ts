/**
 * A card still on a chat's screen after the delay is overdue, once; a card that leaves first
 * never is. And a card offered while another is shown is told as queued, so its chat's wait is
 * known before it reaches the front.
 */
import { describe, expect, it } from "bun:test";
import { createApprovalOverdueTimers } from "../../../src/server/ws/chat-approval-overdue.ts";
import { createPendingApprovals, type ApprovalSlot, type PendingApprovalEvent } from "../../../src/server/ws/chat-pending-approval.ts";
import { serversThatLostSignIn, connectedServerNames } from "../../../src/services/mcp-oauth/mcp-oauth-redirect.ts";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
  };
}

describe("overdue cards", () => {
  it("fires once for a card still shown after the delay, with when it was shown", () => {
    const clock = fakeClock();
    const fired: Array<[string, string, number]> = [];
    const t = createApprovalOverdueTimers({ delayMs: () => 180_000, ...clock, fire: (s, r, at) => fired.push([s, r, at]) });
    clock.advance(5_000);
    t.arm("chat", "req");
    t.arm("chat", "req");
    clock.advance(179_999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([["chat", "req", 5_000]]);
    clock.advance(600_000);
    expect(fired).toHaveLength(1);
    expect(t.size()).toBe(0);
  });

  it("never fires for a card that left first", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const t = createApprovalOverdueTimers({ delayMs: () => 180_000, ...clock, fire: (_s, r) => fired.push(r) });
    t.arm("chat", "req");
    clock.advance(60_000);
    t.cancel("req");
    clock.advance(600_000);
    expect(fired).toEqual([]);
  });
});

describe("a card offered behind another", () => {
  it("is told as queued, and shown when the one in front leaves", () => {
    const shown: string[] = [];
    const queued: string[] = [];
    const pa = createPendingApprovals({
      show: (_s, e) => shown.push(e.requestId),
      queued: (_s, e) => queued.push(e.requestId),
      announceResolved: () => {}, denyProvider: () => {}, endEndpoint: () => {},
    });
    const slot: ApprovalSlot = {};
    const ev = (id: string): PendingApprovalEvent => ({ type: "approval_request", requestId: id, tool: "Bash", input: {} });
    expect(pa.offer("chat", slot, ev("a"))).toBe("shown");
    expect(pa.offer("chat", slot, ev("b"))).toBe("queued");
    expect(queued).toEqual(["b"]);
    pa.clear("chat", slot, "a", { code: "answered", message: "" });
    expect(shown).toEqual(["a", "b"]);
  });
});

describe("MCP servers that lost their sign-in mid-session", () => {
  it("names only servers connected at the previous init", () => {
    const first = [{ name: "vanta", status: "connected" }, { name: "slack", status: "needs-auth" }];
    expect(connectedServerNames(first)).toEqual(["vanta"]);
    expect(serversThatLostSignIn(undefined, ["slack"])).toEqual([]);
    expect(serversThatLostSignIn(connectedServerNames(first), ["slack", "vanta"])).toEqual(["vanta"]);
  });
});
