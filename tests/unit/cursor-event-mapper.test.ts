import { describe, test, expect } from "bun:test";
import { mapCursorEvent } from "../../src/providers/cursor-cli/cursor-event-mapper.ts";

describe("mapCursorEvent", () => {
  test("maps system.init to system event", () => {
    const events = mapCursorEvent(
      { type: "system", subtype: "init", session_id: "abc123", model: "claude-3-5-sonnet" },
      "session-1",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "system", subtype: "init" });
  });

  test("suppresses user messages", () => {
    const events = mapCursorEvent(
      { type: "user", message: { content: "hello" } },
      "session-1",
    );
    expect(events).toEqual([]);
  });

  test("maps assistant text content", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } },
      "session-1",
    );
    expect(events).toEqual([{ type: "text", content: "Hello world" }]);
  });

  test("maps assistant reasoning to thinking", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [{ type: "reasoning", text: "Let me think..." }] } },
      "session-1",
    );
    expect(events).toEqual([{ type: "thinking", content: "Let me think..." }]);
  });

  test("maps tool-call with ApplyPatch → Edit normalization", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [
        { type: "tool-call", toolName: "ApplyPatch", args: { file: "test.ts" }, toolCallId: "tool-1" },
      ] } },
      "session-1",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      tool: "Edit",
      input: { file: "test.ts" },
      toolUseId: "tool-1",
    });
  });

  test("maps tool_use format (alternative naming)", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [
        { type: "tool_use", name: "Read", input: { path: "src/index.ts" }, id: "t2" },
      ] } },
      "session-1",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      tool: "Read",
      input: { path: "src/index.ts" },
      toolUseId: "t2",
    });
  });

  test("maps multiple content parts in single message", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [
        { type: "text", text: "I'll edit the file" },
        { type: "tool-call", toolName: "Read", args: { path: "src/index.ts" }, toolCallId: "t1" },
      ] } },
      "session-1",
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("tool_use");
  });

  test("handles result event (returns empty — done handled by base)", () => {
    const events = mapCursorEvent(
      { type: "result", subtype: "success" },
      "session-1",
    );
    expect(events).toEqual([]);
  });

  test("handles unknown event type gracefully", () => {
    const events = mapCursorEvent({ type: "unknown_type" }, "session-1");
    expect(events).toEqual([]);
  });

  test("handles null/undefined input", () => {
    expect(mapCursorEvent(null, "s")).toEqual([]);
    expect(mapCursorEvent(undefined, "s")).toEqual([]);
  });

  test("handles assistant with no content array", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: {} },
      "session-1",
    );
    expect(events).toEqual([]);
  });

  test("skips null content parts", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [null, { type: "text", text: "hi" }] } },
      "session-1",
    );
    expect(events).toEqual([{ type: "text", content: "hi" }]);
  });

  test("preserves non-ApplyPatch tool names", () => {
    const events = mapCursorEvent(
      { type: "assistant", message: { content: [
        { type: "tool-call", toolName: "Bash", args: { command: "ls" }, toolCallId: "t1" },
      ] } },
      "session-1",
    );
    expect(events[0]).toMatchObject({ type: "tool_use", tool: "Bash" });
  });
});
