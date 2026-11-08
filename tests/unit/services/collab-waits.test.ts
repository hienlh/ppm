import { describe, expect, it } from "bun:test";
import { createCollabWaits } from "../../../src/services/session-collab/collab-waits.ts";

const reply = { text: "done", sentAt: new Date(0).toISOString() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(idle: Record<string, boolean> = {}) {
  return createCollabWaits({ canonical: (id) => id.replace(/^old-/, ""), isIdle: (id) => idle[id] ?? true, graceMs: 10 });
}

function begin(waits: ReturnType<typeof setup>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const begun = waits.begin({ waiter: "A", target: "B", timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!begun.ok) throw new Error(begun.message);
  return begun.wait;
}

describe("collab waits", () => {
  it("returns the target's reply, once, and says so to the sender so it is not delivered again", async () => {
    const waits = setup();
    const wait = begin(waits);
    wait.attach("session-1", "started", false);
    expect(waits.claimReply("B", "A", reply)).toBe(true);
    expect(await wait.outcome).toEqual({ replied: true, text: "done", sentAt: reply.sentAt });
    // A second message from B finds no wait: the caller delivers it as a new message.
    expect(waits.claimReply("B", "A", reply)).toBe(false);
    expect(waits.size()).toBe(0);
  });

  it("matches a reply by canonical id, after a provider renamed either session", async () => {
    const waits = setup();
    const wait = begin(waits);
    expect(waits.claimReply("old-B", "old-A", reply)).toBe(true);
    expect((await wait.outcome).replied).toBe(true);
  });

  it("takes a reply that arrives before the delivery returned", async () => {
    const waits = setup();
    const wait = begin(waits);
    expect(waits.claimReply("B", "A", reply)).toBe(true);
    wait.attach("session-1", "inserted", false);
    expect((await wait.outcome).replied).toBe(true);
  });

  it("ends without a reply once the turn that took the message ends", async () => {
    const waits = setup();
    const wait = begin(waits);
    wait.attach("session-1", "queued", false);
    waits.turnBound("session-1");
    waits.turnEnded("B");
    expect(await wait.outcome).toEqual({ replied: false, reason: "turn_ended_without_reply" });
  });

  it("ignores a turn end that came before the message was delivered", async () => {
    const waits = setup();
    const wait = begin(waits, { timeoutMs: 40 });
    waits.turnEnded("B");
    await sleep(20);
    wait.attach("session-1", "started", false);
    expect(await wait.outcome).toEqual({ replied: false, reason: "timeout" });
  });

  it("recognises a turn that took the message and ended before the delivery returned to its wait", async () => {
    const waits = setup();
    const quick = begin(waits);
    waits.turnBound("session-1");
    waits.turnEnded("B");
    quick.attach("session-1", "started", false);
    expect(await quick.outcome).toEqual({ replied: false, reason: "turn_ended_without_reply" });

    // An end before the message's turn was named was the target's previous turn: the wait goes on.
    const queued = waits.begin({ waiter: "A", target: "B", timeoutMs: 30 });
    if (!queued.ok) throw new Error(queued.message);
    waits.turnEnded("B");
    waits.turnBound("session-2");
    queued.wait.attach("session-2", "queued", false);
    expect(await queued.wait.outcome).toEqual({ replied: false, reason: "timeout" });
  });

  it("judges an unnamed message after a grace: idle means read, a new turn means the wait goes on", async () => {
    const idle: Record<string, boolean> = { B: false };
    const waits = setup(idle);
    const wait = begin(waits, { timeoutMs: 80 });
    wait.attach("session-1", "queued", false);
    waits.turnEnded("B"); // the turn the message was queued behind; a new one started at once
    await sleep(25);
    expect(waits.size()).toBe(1);
    idle.B = true;
    waits.turnEnded("B");
    expect(await wait.outcome).toEqual({ replied: false, reason: "turn_ended_without_reply" });
  });

  it("times out", async () => {
    const waits = setup();
    const wait = begin(waits, { timeoutMs: 5 });
    wait.attach("session-1", "started", true);
    expect(await wait.outcome).toEqual({ replied: false, reason: "timeout" });
    // The reply after the timeout is the caller's to deliver as a new message.
    expect(waits.claimReply("B", "A", reply)).toBe(false);
  });

  it("is cancelled by the call's abort, the waiter's own turn ending, or the user writing to the waiter", async () => {
    const waits = setup();
    const controller = new AbortController();
    const a = begin(waits, { signal: controller.signal });
    controller.abort();
    expect(await a.outcome).toEqual({ replied: false, reason: "cancelled" });

    const b = begin(waits);
    waits.turnEnded("A");
    expect((await b.outcome).replied).toBe(false);

    const c = begin(waits);
    expect(waits.cancelWaiter("A")).toBe(1);
    expect(await c.outcome).toEqual({ replied: false, reason: "cancelled" });
  });

  it("settles once: whatever comes first wins and the rest find nothing", async () => {
    const waits = setup();
    const wait = begin(waits);
    wait.attach("session-1", "started", true);
    waits.cancelWaiter("A");
    expect(waits.claimReply("B", "A", reply)).toBe(false);
    waits.turnEnded("B");
    expect(await wait.outcome).toEqual({ replied: false, reason: "cancelled" });
  });

  it("allows one wait per pair at a time", () => {
    const waits = setup();
    begin(waits);
    const second = waits.begin({ waiter: "A", target: "B", timeoutMs: 1000 });
    expect(second.ok).toBe(false);
    expect(waits.begin({ waiter: "A", target: "C", timeoutMs: 1000 }).ok).toBe(true);
    waits.cancelWaiter("A");
  });
});
