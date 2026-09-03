import { describe, test, expect } from "bun:test";
import {
  applyBackgroundAgentStatus,
  isAsyncAgentLaunchAck,
  isTerminalAgentStatus,
  parseTaskNotifications,
} from "../../../src/shared/background-agent-status.ts";
import type { ChatEvent, ChatMessage } from "../../../src/types/chat.ts";

/** The literal text the Agent tool returns for an async launch, as recorded in transcripts. */
const LAUNCH_ACK =
  'Async agent launched successfully. (This tool result is internal metadata — never quote'
  + " or paste any part of it, including the agentId below, into a user-facing message.)";

function notification(toolUseId: string | null, status: string): string {
  return [
    "<task-notification>",
    "<task-id>a8531e43894c304c9</task-id>",
    ...(toolUseId ? [`<tool-use-id>${toolUseId}</tool-use-id>`] : []),
    `<status>${status}</status>`,
    "<summary>Agent \"Review PR\" finished</summary>",
    "</task-notification>",
  ].join("\n");
}

function agentCall(toolUseId: string): ChatEvent {
  return { type: "tool_use", tool: "Agent", input: { description: "Review PR" }, toolUseId };
}

function msg(role: ChatMessage["role"], content: string, events?: ChatEvent[]): ChatMessage {
  return { id: `${role}-${content.slice(0, 8)}`, role, content, timestamp: "2026-09-03T00:00:00Z", ...(events && { events }) };
}

describe("isAsyncAgentLaunchAck", () => {
  test("recognises the launch acknowledgement", () => {
    expect(isAsyncAgentLaunchAck(LAUNCH_ACK)).toBe(true);
  });

  test("a synchronous agent's report is not an ack", () => {
    expect(isAsyncAgentLaunchAck("## Findings\n\nThe parser drops the trailing byte.")).toBe(false);
  });

  test("missing output is not an ack", () => {
    expect(isAsyncAgentLaunchAck(undefined)).toBe(false);
    expect(isAsyncAgentLaunchAck("")).toBe(false);
  });
});

describe("isTerminalAgentStatus", () => {
  test("accepts every state the CLI reports for a finished task", () => {
    expect(isTerminalAgentStatus("completed")).toBe(true);
    expect(isTerminalAgentStatus("failed")).toBe(true);
    expect(isTerminalAgentStatus("stopped")).toBe(true);
  });

  test("rejects in-flight and unknown states", () => {
    expect(isTerminalAgentStatus("running")).toBe(false);
    expect(isTerminalAgentStatus(undefined)).toBe(false);
  });
});

describe("parseTaskNotifications", () => {
  test("maps tool-use-id to status", () => {
    const got = parseTaskNotifications(notification("toolu_01A", "completed"));
    expect([...got]).toEqual([["toolu_01A", "completed"]]);
  });

  test("reads every notification in one message", () => {
    const content = `${notification("toolu_01A", "completed")}\n${notification("toolu_01B", "failed")}`;
    expect([...parseTaskNotifications(content)]).toEqual([
      ["toolu_01A", "completed"],
      ["toolu_01B", "failed"],
    ]);
  });

  test("skips orphan-scan summaries, which carry no tool-use-id", () => {
    expect(parseTaskNotifications(notification(null, "stopped")).size).toBe(0);
  });

  test("ignores content with no notification at all", () => {
    expect(parseTaskNotifications("just a user message").size).toBe(0);
  });
});

describe("applyBackgroundAgentStatus", () => {
  test("stamps a notification onto the agent call from an earlier turn", () => {
    const call = agentCall("toolu_01A");
    const messages = [
      msg("assistant", "spawning", [call]),
      msg("assistant", "meanwhile…", []),
      msg("user", notification("toolu_01A", "completed")),
    ];

    applyBackgroundAgentStatus(messages);

    expect((call as any).bgStatus).toBe("completed");
  });

  test("leaves a still-running agent unstamped", () => {
    const running = agentCall("toolu_01A");
    const finished = agentCall("toolu_01B");
    const messages = [
      msg("assistant", "spawning two", [running, finished]),
      msg("user", notification("toolu_01B", "failed")),
    ];

    applyBackgroundAgentStatus(messages);

    expect((running as any).bgStatus).toBeUndefined();
    expect((finished as any).bgStatus).toBe("failed");
  });

  test("ignores non-subagent tools that happen to share an id", () => {
    const bash: ChatEvent = { type: "tool_use", tool: "Bash", input: {}, toolUseId: "toolu_01A" };
    const messages = [msg("assistant", "ran", [bash]), msg("user", notification("toolu_01A", "completed"))];

    applyBackgroundAgentStatus(messages);

    expect((bash as any).bgStatus).toBeUndefined();
  });

  test("no notifications leaves every event untouched", () => {
    const call = agentCall("toolu_01A");
    applyBackgroundAgentStatus([msg("assistant", "spawning", [call])]);
    expect((call as any).bgStatus).toBeUndefined();
  });
});
