import { describe, it, expect } from "bun:test";
import { DECLINED_COMMAND_OUTPUT, mapCodexEvent, newCodexTurnText } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

const SID = "thread-1";

describe("mapCodexEvent: several agent messages in one turn", () => {
  /** The text a chat shows for a turn: every text event appended, as the live view does. */
  function streamedText(notifs: Array<{ method: string; params?: unknown }>): string {
    const turn = newCodexTurnText();
    return notifs.flatMap((n) => mapCodexEvent(n, SID, turn))
      .map((ev) => (ev.type === "text" ? ev.content : "")).join("");
  }
  const started = (id: string, type = "agentMessage") => ({ method: "item/started", params: { item: { type, id } } });
  const delta = (itemId: string, text: string) => ({ method: "item/agentMessage/delta", params: { itemId, delta: text } });

  it("keeps two messages around a tool call apart, as the transcript reader does", () => {
    const text = streamedText([
      { method: "turn/started", params: { turn: { id: "t1" } } },
      started("m1"), delta("m1", "Đã đăng ký trong "), delta("m1", "PPM."),
      started("call", "mcpToolCall"),
      started("m2"), delta("m2", "PPM hiện có 2 project."),
    ]);
    expect(text).toBe("Đã đăng ký trong PPM.\n\nPPM hiện có 2 project.");
  });

  it("splits on a new item id even when codex does not announce the message", () => {
    expect(streamedText([delta("m1", "One."), delta("m2", "Two.")])).toBe("One.\n\nTwo.");
  });

  it("never opens a turn, or follows an empty message, with a blank paragraph", () => {
    expect(streamedText([started("m0"), started("m1"), delta("m1", "First.")])).toBe("First.");
  });

  it("starts each turn afresh", () => {
    const turn = newCodexTurnText();
    mapCodexEvent(delta("m1", "Earlier turn."), SID, turn);
    mapCodexEvent({ method: "turn/completed", params: {} }, SID, turn);
    mapCodexEvent(started("m2"), SID, turn);
    expect(mapCodexEvent(delta("m2", "Next."), SID, turn)).toEqual([{ type: "text", content: "Next." }]);
  });

  it("maps each delta on its own when the caller keeps no turn state (a child thread)", () => {
    expect(mapCodexEvent(delta("m2", "Two."), SID)).toEqual([{ type: "text", content: "Two." }]);
  });
});

describe("mapCodexEvent", () => {
  it("maps a fileChange over several files to one call that lists every file", () => {
    const [use] = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "fileChange", id: "fc1", status: "inProgress", changes: [
        { path: "/p/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
        { path: "/p/b.ts", kind: { type: "add" }, diff: "new file\n" },
      ] } },
    }, "s") as any[];
    expect(use).toMatchObject({ type: "tool_use", tool: "Edit", toolUseId: "fc1", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } });
    expect(use.input.files.map((f: any) => [f.file_path, f.op, f.new_string])).toEqual([["/p/a.ts", "update", "b"], ["/p/b.ts", "add", "new file\n"]]);
  });

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

  it("completed webSearch updates an initially blank query and formats results", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: {
        type: "webSearch", id: "w1", query: "OpenAI Codex docs",
        results: [{ title: "Codex", url: "https://learn.chatgpt.com/codex", snippet: "Build with Codex." }],
      } },
    }, SID) as any[];
    expect(out[0]).toMatchObject({ type: "tool_use", tool: "WebSearch", input: { query: "OpenAI Codex docs" }, toolUseId: "w1" });
    expect(out[1]).toMatchObject({ type: "tool_result", toolUseId: "w1", isError: false });
    expect(out[1].output).toBe("Found 1 result.\n1. Codex\n   https://learn.chatgpt.com/codex\n   Build with Codex.");
  });

  it("completed webSearch reports an empty result set without dumping its item JSON", () => {
    const out = mapCodexEvent({
      method: "item/completed", params: { item: { type: "webSearch", id: "w2", query: "nothing", results: [] } },
    }, SID) as any[];
    expect(out[1].output).toBe("Search completed with no results.");
    expect(out[1].output).not.toContain('"type"');
  });

  it("item/completed(commandExecution exit!=0) → tool_result isError", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i1", aggregatedOutput: "boom", exitCode: 1 } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true, exitCode: 1, toolUseId: "i1" });
  });

  it("item/completed(commandExecution exit 0) → tool_result not error", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i2", aggregatedOutput: "ok", exitCode: 0 } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: false, exitCode: 0, toolUseId: "i2" });
  });

  it("item/completed(commandExecution declined) → an error saying it did not run", () => {
    // A declined command never ran, so it has no exit code; the status alone says so.
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "i4", aggregatedOutput: null, exitCode: null, status: "declined" } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true, toolUseId: "i4", output: DECLINED_COMMAND_OUTPUT });
    expect(out[0]).not.toHaveProperty("exitCode");
  });

  it("item/completed(fileChange declined) → tool_result isError", () => {
    const out = mapCodexEvent({
      method: "item/completed",
      params: { item: { type: "fileChange", id: "f1", changes: [], status: "declined" } },
    }, SID);
    expect(out[0]).toMatchObject({ type: "tool_result", isError: true, toolUseId: "f1" });
  });

  it("turn/completed → done", () => {
    expect(mapCodexEvent({ method: "turn/completed", params: {} }, SID))
      .toEqual([{ type: "done", sessionId: SID, resultSubtype: "success" }]);
  });

  it("error → error", () => {
    const out = mapCodexEvent({ method: "error", params: { error: { message: "bad" } } }, SID);
    expect(out).toEqual([{ type: "error", message: "bad" }]);
  });

  it("error with willRetry → retrying status, not an error", () => {
    const out = mapCodexEvent({
      method: "error",
      params: { error: { message: "Reconnecting... 2/5", additionalDetails: "unauthorized (401)" }, willRetry: true },
    }, SID);
    expect(out).toEqual([{ type: "status_update", phase: "retrying", message: "Reconnecting... 2/5" }]);
  });

  it("error with willRetry false stays an error", () => {
    const out = mapCodexEvent({ method: "error", params: { error: { message: "gave up" }, willRetry: false } }, SID);
    expect(out).toEqual([{ type: "error", message: "gave up" }]);
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
