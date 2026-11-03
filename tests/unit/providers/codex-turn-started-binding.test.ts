import { describe, expect, it } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A live session on a recording client whose every `turn/start` opens a new numbered turn. */
function makeLive(provider: any, sessionId: string) {
  const pushed: any[] = [];
  let turns = 0;
  const live: any = {
    client: {
      isClosed: false,
      close() { this.isClosed = true; },
      request(method: string) {
        if (method === "turn/start") return Promise.resolve({ turn: { id: `turn-${++turns}`, status: "inProgress" } });
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
    pendingTurns: [], subagentThreadIds: new Set(),
  };
  provider.live.set(sessionId, live);
  return { live, started: () => pushed.filter((e) => e.type === "turn_started") };
}

const completeTurn = (provider: any, live: any) =>
  provider.handleNotification(live, { method: "turn/completed", params: { threadId: live.threadId } });

describe("codex turn_started", () => {
  it("names the turn a message opened, once codex names it, and tags the message", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, started } = makeLive(p, "b1");
    p.startTurn(live, "first", { clientMessageId: "c1" });
    await tick();
    p.handleNotification(live, { method: "turn/started", params: { turn: { id: "turn-1" } } });
    expect(started()).toEqual([{ type: "turn_started", turnId: "turn-1", clientMessageId: "c1" }]);
    expect(live.transcript[0].turnId).toBe("turn-1");
    p.cleanupAll();
  });

  it("a steered message is bound to the running turn, not to one of its own", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, started } = makeLive(p, "b2");
    p.startTurn(live, "first", { clientMessageId: "c1" });
    await tick();
    p.pushMessage("b2", "also this", { clientMessageId: "c2", priority: "next" });
    await tick();
    expect(started()).toEqual([
      { type: "turn_started", turnId: "turn-1", clientMessageId: "c1" },
      { type: "turn_started", turnId: "turn-1", clientMessageId: "c2" },
    ]);
    expect(live.transcript.map((m: any) => [m.content, m.turnId])).toEqual([["first", "turn-1"], ["also this", "turn-1"]]);
    p.cleanupAll();
  });

  it("a queued message gets its own turn's id when that turn starts, not the newest one's", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, started } = makeLive(p, "b3");
    p.startTurn(live, "first", { clientMessageId: "c1" });
    await tick();
    p.pushMessage("b3", "later one", { clientMessageId: "c3", priority: "later" });
    p.pushMessage("b3", "later two", { clientMessageId: "c4", priority: "later" });
    await tick();
    expect(started().map((e) => e.clientMessageId)).toEqual(["c1"]);
    completeTurn(p, live);
    await tick();
    completeTurn(p, live);
    await tick();
    expect(started().map((e) => [e.turnId, e.clientMessageId])).toEqual([["turn-1", "c1"], ["turn-2", "c3"], ["turn-3", "c4"]]);
    p.cleanupAll();
  });

  it("a compaction is not announced: it is no turn anyone sees", async () => {
    const p: any = new CodexAppServerProvider();
    const { live, started } = makeLive(p, "b4");
    p.startTurn(live, "/compact", { clientMessageId: "c1" });
    await tick();
    p.handleNotification(live, { method: "turn/started", params: { turn: { id: "turn-compact" } } });
    expect(started()).toEqual([]);
    p.cleanupAll();
  });
});
