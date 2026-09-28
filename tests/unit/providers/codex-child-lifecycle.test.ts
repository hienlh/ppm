import { describe, expect, it } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";

function fixture() {
  const provider: any = new CodexAppServerProvider();
  const events: any[] = [];
  const calls: any[] = [];
  const usage: any[] = [];
  const live: any = {
    threadId: "root", cwd: "/tmp", permission: {},
    client: { request: (method: string, params: any) => {
      calls.push({ method, params });
      return Promise.resolve({ turn: { id: "next-turn" } });
    } },
    channel: { push: (event: any) => events.push(event) },
    history: [], transcript: [], currentAssistant: "Root answer", currentEvents: [],
    pendingTurns: [], subagentThreadIds: new Set(["child"]),
    turnInFlight: true, activeTurnId: "root-turn",
  };
  provider.recordTurnUsage = (_: any, value: any) => usage.push(value);
  provider.handleAuthFailure = () => calls.push("auth");
  provider.beginRotation = () => { calls.push("rotation"); return true; };
  const notify = (method: string, params: any = {}, threadId = "child") =>
    provider.handleNotification(live, { method, params: { threadId, ...params } });
  return { live, events, calls, usage, notify };
}

describe("Codex child lifecycle isolation", () => {
  it("keeps the root active through child start, text, usage and completion", () => {
    const { live, events, calls, usage, notify } = fixture();
    notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } }, "root");
    const rootUsage = live.lastUsage;
    notify("turn/started", { turn: { id: "child-turn" } });
    notify("item/agentMessage/delta", { delta: "Child answer" });
    notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 900, outputTokens: 50 } } });
    notify("turn/completed", { turn: { status: "completed" } });

    expect(live.activeTurnId).toBe("root-turn");
    expect(live.turnInFlight).toBe(true);
    expect(live.currentAssistant).toBe("Root answer");
    expect(live.transcript).toEqual([]);
    expect(live.lastUsage).toBe(rootUsage);
    expect(events).toEqual([{ type: "text", content: "Child answer", parentToolUseId: "subagent-child" }]);
    expect(calls).toEqual([]);
    expect(usage).toEqual([]);

    notify("turn/completed", { turn: { status: "completed" } }, "root");
    expect(live.turnInFlight).toBe(false);
    expect(live.transcript.map((m: any) => m.content)).toEqual(["Root answer"]);
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", sessionId: "root", resultSubtype: "success", usage: rootUsage }]);
    expect(usage).toEqual([rootUsage]);
  });

  it("does not release a queued root turn when a child finishes", async () => {
    const { live, calls, notify } = fixture();
    live.pendingTurns.push({ message: "follow-up" });
    notify("turn/completed");
    await Promise.resolve();
    expect(live.pendingTurns).toHaveLength(1);
    expect(calls).toEqual([]);
    notify("turn/completed", {}, "root");
    await Promise.resolve();
    expect(calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
  });

  it("isolates errors and compaction from root account and phase state", () => {
    const { live, calls, events, notify } = fixture();
    live.compactRequested = true;
    notify("error", { error: { message: "401 Unauthorized" } });
    notify("error", { error: { message: "You've hit your usage limit" } });
    notify("error", { error: { message: "Reconnecting... 1/5" }, willRetry: true });
    notify("item/started", { item: { type: "contextCompaction" } });
    notify("item/completed", { item: { type: "contextCompaction" } });
    notify("thread/compacted");
    expect(calls).toEqual([]);
    expect(live.compactRequested).toBe(true);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "error" && e.parentToolUseId === "subagent-child")).toBe(true);
  });

  it("does not let a child completion release a discarded root turn", () => {
    const { live, events, notify } = fixture();
    live.discardingTurn = true;
    notify("turn/completed");
    expect(live.discardingTurn).toBe(true);
    expect(live.turnInFlight).toBe(true);
    expect(live.currentAssistant).toBe("Root answer");
    expect(events).toEqual([]);
    notify("turn/completed", {}, "root");
    expect(live.discardingTurn).toBe(false);
    expect(live.turnInFlight).toBe(false);
  });

  it("nests early child content and preserves tools without buffering late tools", () => {
    const { live, events, notify } = fixture();
    live.subagentThreadIds.clear();
    notify("item/reasoning/textDelta", { delta: "Working" });
    notify("item/started", { item: { type: "commandExecution", id: "cmd", command: "pwd" } });
    expect(events.every((e) => e.parentToolUseId === "subagent-child")).toBe(true);
    expect(live.currentEvents).toHaveLength(1);
    notify("turn/completed", {}, "root");
    notify("item/completed", { item: { type: "commandExecution", id: "cmd", aggregatedOutput: "/tmp", exitCode: 0 } });
    notify("turn/started", { turn: { id: "late-child-turn" } });
    notify("turn/completed");
    expect(events.at(-1)).toMatchObject({ type: "tool_result", toolUseId: "cmd", parentToolUseId: "subagent-child" });
    expect(live.currentEvents).toEqual([]);
    expect(live.turnInFlight).toBe(false);
    expect(live.transcript).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});
