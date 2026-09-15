import { describe, it, expect } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

interface SentRequest { method: string; params: any }

/**
 * Minimal live session wired to a recording client. Codex accepts one turn per
 * thread, so what matters is WHICH requests leave and when — not their replies.
 */
function makeLive(provider: any, sessionId: string, turnId = "turn-1") {
  const sent: SentRequest[] = [];
  const pushed: any[] = [];
  const live: any = {
    client: {
      isClosed: false,
      close() { this.isClosed = true; },
      request(method: string, params: any) {
        sent.push({ method, params });
        if (method === "turn/start") return Promise.resolve({ turn: { id: turnId, status: "inProgress" } });
        return Promise.resolve({});
      },
    },
    threadId: sessionId,
    cwd: "/tmp",
    channel: { push: (ev: any) => pushed.push(ev), done: () => {}, iterator: null },
    permission: {},
    pendingApprovals: new Map(),
    answeredCodexIds: new Set(),
    history: [], transcript: [], currentAssistant: "", currentEvents: [],
    pendingTurns: [],
  };
  provider.live.set(sessionId, live);
  return { live, sent, pushed };
}

const turnStarts = (sent: SentRequest[]) =>
  sent.filter((r) => r.method === "turn/start").map((r) => r.params.input.at(-1).text);

/** The notification codex sends when a turn ends; the provider drains on it. */
const completeTurn = (provider: any, live: any) =>
  provider.handleNotification(live, { method: "turn/completed", params: { threadId: live.threadId } });

describe("codex follow-up queue", () => {
  it("holds a follow-up sent mid-turn and sends it when the turn completes", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, sent } = makeLive(p, "s1");

    p.startTurn(live, "first");
    await tick();
    p.pushMessage("s1", "second");
    // Codex would silently discard a concurrent turn/start, so nothing goes out yet.
    expect(turnStarts(sent)).toEqual(["first"]);
    expect(live.pendingTurns.length).toBe(1);

    completeTurn(p, live);
    await tick();
    expect(turnStarts(sent)).toEqual(["first", "second"]);
    expect(live.pendingTurns.length).toBe(0);
    p.cleanupAll();
  });

  it("interrupts the running turn for priority now", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, sent } = makeLive(p, "s2", "turn-abc");

    p.startTurn(live, "first");
    await tick(); // turn/start reply names the turn
    p.pushMessage("s2", "urgent", { priority: "now" });

    const interrupt = sent.find((r) => r.method === "turn/interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt!.params).toEqual({ threadId: "s2", turnId: "turn-abc" });
    // Interrupting does not send the follow-up — the interrupted turn's own
    // turn/completed is what releases it.
    expect(turnStarts(sent)).toEqual(["first"]);

    completeTurn(p, live);
    await tick();
    expect(turnStarts(sent)).toEqual(["first", "urgent"]);
    p.cleanupAll();
  });

  it("defers an interrupt asked for before the turn is named", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, sent } = makeLive(p, "s3");
    live.turnInFlight = true; // turn issued, turn/start not yet answered

    p.pushMessage("s3", "urgent", { priority: "now" });
    expect(sent.find((r) => r.method === "turn/interrupt")).toBeUndefined();
    expect(live.interruptRequested).toBe(true);

    p.handleNotification(live, { method: "turn/started", params: { turn: { id: "turn-late" } } });
    expect(sent.find((r) => r.method === "turn/interrupt")?.params.turnId).toBe("turn-late");
    p.cleanupAll();
  });

  it("sends next ahead of an already-queued later", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, sent } = makeLive(p, "s4");

    p.startTurn(live, "first");
    await tick();
    p.pushMessage("s4", "whenever", { priority: "later" });
    p.pushMessage("s4", "sooner", { priority: "next" });

    completeTurn(p, live);
    await tick();
    completeTurn(p, live);
    await tick();
    expect(turnStarts(sent)).toEqual(["first", "sooner", "whenever"]);
    p.cleanupAll();
  });

  it("releases the queue when a turn never starts", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, sent, pushed } = makeLive(p, "s5");
    live.client.request = (method: string, params: any) => {
      sent.push({ method, params });
      if (method === "turn/start" && params.input.at(-1).text === "first") {
        return Promise.reject(new Error("thread is gone"));
      }
      return Promise.resolve({ turn: { id: "t" } });
    };

    p.startTurn(live, "first");
    p.pushMessage("s5", "second");
    await tick();
    // A rejected turn reports no turn/completed, so the follow-up must not wait
    // on one — otherwise every later message queues forever.
    expect(turnStarts(sent)).toEqual(["first", "second"]);
    expect(pushed.some((e) => e.type === "error")).toBe(true);
    p.cleanupAll();
  });
});
