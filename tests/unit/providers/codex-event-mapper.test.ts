import { describe, it, expect } from "bun:test";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

const SID = "thread-1";

describe("mapCodexEvent", () => {
  it("agentMessage/delta → text", () => {
    expect(mapCodexEvent({ method: "item/agentMessage/delta", params: { delta: "Hi" } }, SID))
      .toEqual([{ type: "text", content: "Hi" }]);
  });

  it("reasoning/textDelta → thinking", () => {
    expect(mapCodexEvent({ method: "item/reasoning/textDelta", params: { delta: "hmm" } }, SID))
      .toEqual([{ type: "thinking", content: "hmm" }]);
  });

  it("reasoning/summaryTextDelta → thinking", () => {
    expect(mapCodexEvent({ method: "item/reasoning/summaryTextDelta", params: { delta: "Checking the request" } }, "s")).toEqual([
      { type: "thinking", content: "Checking the request" },
    ]);
  });

  it("item/started(commandExecution) → Bash tool_use with toolUseId", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "commandExecution", id: "i1", command: "ls", cwd: "/x" } },
    }, SID);
    expect(out).toEqual([{ type: "tool_use", tool: "Bash", input: { command: "ls", cwd: "/x" }, toolUseId: "i1" }]);
  });

  it("commandExecution running powershell → PowerShell tool", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "commandExecution", id: "i2", command: '"C:\\\\...\\\\powershell.exe" -Command Get-Location', cwd: "C:\\x" } },
    }, SID);
    expect((out[0] as any).tool).toBe("PowerShell");
    expect((out[0] as any).input.command).toContain("powershell.exe");
  });

  it("webSearch → WebSearch tool with query", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "webSearch", id: "w1", query: "bun test" } },
    }, SID);
    expect(out).toEqual([{ type: "tool_use", tool: "WebSearch", input: { query: "bun test" }, toolUseId: "w1" }]);
  });

  it("item/completed(commandExecution exit!=0) → tool_result isError", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i1", aggregatedOutput: "boom", exitCode: 1 } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true, toolUseId: "i1" });
  });

  it("item/completed(commandExecution exit 0) → tool_result not error", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i2", aggregatedOutput: "ok", exitCode: 0 } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: false, toolUseId: "i2" });
  });

  it("turn/completed → done", () => {
    expect(mapCodexEvent({ method: "turn/completed", params: {} }, SID))
      .toEqual([{ type: "done", sessionId: SID, resultSubtype: "success" }]);
  });

  it("error → error", () => {
    const out = mapCodexEvent({ method: "error", params: { error: { message: "bad" } } }, SID);
    expect(out).toEqual([{ type: "error", message: "bad" }]);
  });

  it("tokenUsage/rateLimits → [] (usage cut)", () => {
    expect(mapCodexEvent({ method: "thread/tokenUsage/updated", params: {} }, SID)).toEqual([]);
    expect(mapCodexEvent({ method: "account/rateLimits/updated", params: {} }, SID)).toEqual([]);
  });

  it("unknown method → []", () => {
    expect(mapCodexEvent({ method: "thread/whatever", params: {} }, SID)).toEqual([]);
  });

  it("truncates large tool_result output", () => {
    const big = "z".repeat(20000);
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i3", aggregatedOutput: big, exitCode: 0 } },
    }, SID);
    expect((out[0] as any).output.length).toBeLessThan(big.length);
  });

  it("never throws on malformed params", () => {
    expect(() => mapCodexEvent({ method: "item/started", params: null }, SID)).not.toThrow();
    expect(mapCodexEvent({ method: "item/started", params: null }, SID)).toEqual([]);
  });
});

describe("mapCodexEvent — spawned subagents", () => {
  const SID2 = "s-sub";
  const started = {
    method: "item/started",
    params: { item: { type: "subAgentActivity", id: "call_a", kind: "started", agentThreadId: "t-9", agentPath: "/root/review" } },
  };
  const completed = {
    method: "item/completed",
    params: { item: { type: "subAgentActivity", id: "subagent-completed-b", kind: "completed", agentThreadId: "t-9", agentPath: "/root/review" } },
  };

  it("start → one Agent card named after the agent", () => {
    const out = mapCodexEvent(started, SID2);
    expect(out.length).toBe(1);
    expect((out[0] as any).tool).toBe("Agent");
    expect((out[0] as any).input.description).toBe("/root/review");
  });

  it("completion answers that card, despite carrying a different item id", () => {
    const use = mapCodexEvent(started, SID2)[0] as any;
    const res = mapCodexEvent(completed, SID2)[0] as any;
    expect(res.type).toBe("tool_result");
    expect(res.toolUseId).toBe(use.toolUseId); // paired on the thread, not the item id
  });

  it("reads the rollout spelling of the same item", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "SubAgentActivity", id: "call_c", kind: "started", agent_thread_id: "t-9", agent_path: "/root/review" } },
    }, SID2);
    expect((out[0] as any).tool).toBe("Agent");
  });
});
