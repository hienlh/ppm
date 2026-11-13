/**
 * The session tools' card: recognised under either provider's name, waiting while a wait is in
 * flight, the reply once it came, why none did, the tool's error, and an Open session button.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import {
  sessionCollabCardState, sessionCollabToolCall, sessionCollabToolResult, stoppedCallText, waitEndedText, withLiveStatus,
} from "../../../src/web/lib/session-collab-tool-call";
import type { SessionStatus } from "../../../src/shared/session-collab";

installDom();
afterAll(uninstallDom);
const { SessionCollabToolCard } = await import("../../../src/web/components/chat/session-collab-tool-card");
const { ToolCard } = await import("../../../src/web/components/chat/tool-cards");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useStreamingStore } = await import("../../../src/web/stores/streaming-store");
const { useSessionCollabStore } = await import("../../../src/web/stores/session-collab-store");

const target = "cccccccc-2222-4000-8000-000000000002";
const status: SessionStatus = {
  sessionId: target, title: "Write tests", providerId: "claude", model: null, phase: "idle", waitingFor: null,
  spawnedBy: "aaaaaaaa-0000-4000-8000-000000000001", depth: 1, lastAssistantText: null, unreadReplies: 0, updatedAt: null,
};
let view: Mounted | null = null;

beforeEach(() => {
  useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never, activeProject: { name: "ppm", path: "/p" } as never });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("sessionCollabToolCall", () => {
  it("reads Claude's and Codex's names for the same call", () => {
    expect(sessionCollabToolCall("mcp__ppm-sessions__send_to_session", { session_id: target, message: "hi", wait: true }))
      .toEqual({ tool: "send_to_session", sessionId: target, message: "hi", wait: true });
    expect(sessionCollabToolCall("ppm_sessions:create_session", { server: "ppm_sessions", tool: "create_session", arguments: { title: "T", task: "do it" } }))
      .toEqual({ tool: "create_session", title: "T", task: "do it", wait: false });
    expect(sessionCollabToolCall("mcp__ppm-sessions__session_status", {})).toEqual({ tool: "session_status", sessionIds: [] });
  });

  it("refuses other tools and a send with no target", () => {
    expect(sessionCollabToolCall("mcp__ppm-tabs__open_file", { path: "a" })).toBeNull();
    expect(sessionCollabToolCall("mcp__ppm-sessions__send_to_session", { message: "hi" })).toBeNull();
  });
});

describe("sessionCollabToolResult", () => {
  it("reads the server's JSON, also inside an MCP content array", () => {
    const json = JSON.stringify({ delivered: "inserted", status, reply: { replied: true, text: "ok", sentAt: "x" } });
    const direct = sessionCollabToolResult(json)!;
    expect(direct).toMatchObject({ sessionId: target, title: "Write tests", delivered: "inserted", reply: { replied: true, text: "ok" } });
    expect(sessionCollabToolResult(JSON.stringify([{ type: "text", text: json }]))).toEqual(direct);
  });

  it("drops what is not that JSON, and an unknown wait reason", () => {
    expect(sessionCollabToolResult("Session created.")).toBeNull();
    expect(sessionCollabToolResult(JSON.stringify({ reply: { replied: false, reason: "whatever" } }))).toBeNull();
  });
});

describe("sessionCollabCardState", () => {
  const send = { tool: "send_to_session" as const, sessionId: target, message: "m", wait: true };
  const status = { tool: "session_status" as const, sessionIds: [] };
  it("waits, answers, fails, or was stopped", () => {
    expect(sessionCollabCardState(send, { done: false, isError: false, hasOutput: false })).toBe("waiting");
    expect(sessionCollabCardState(status, { done: false, isError: false, hasOutput: false })).toBe("running");
    expect(sessionCollabCardState(send, { done: true, isError: false, hasOutput: true })).toBe("answered");
    expect(sessionCollabCardState(send, { done: true, isError: true, hasOutput: true })).toBe("error");
    expect(sessionCollabCardState(send, { done: true, isError: false, hasOutput: false })).toBe("stopped");
    expect(sessionCollabCardState(status, { done: true, isError: false, hasOutput: false })).toBe("stopped");
  });
});

describe("withLiveStatus", () => {
  it("brings the reported phase up to what the session does now", () => {
    const busy = { ...status, phase: "thinking" as const, waitingFor: "question" as const };
    expect(withLiveStatus(busy, null)).toBe(busy);
    expect(withLiveStatus(busy, "idle")).toMatchObject({ phase: "idle", waitingFor: null });
    expect(withLiveStatus(busy, "new_message")).toMatchObject({ phase: "idle", waitingFor: null });
    expect(withLiveStatus(busy, "running")).toMatchObject({ phase: "thinking", waitingFor: null });
    expect(withLiveStatus(status, "running")).toMatchObject({ phase: "streaming", waitingFor: null });
    expect(withLiveStatus(status, "needs_approval")).toMatchObject({ phase: "streaming", waitingFor: "approval" });
    expect(withLiveStatus(busy, "needs_approval")).toMatchObject({ waitingFor: "question" });
  });
});

describe("SessionCollabToolCard", () => {
  const send = { tool: "send_to_session" as const, sessionId: target, message: "please review", wait: true };

  it("says it is waiting while the wait is in flight", async () => {
    view = await mount(<SessionCollabToolCard call={send} isError={false} done={false} projectName="ppm" />);
    expect(view.container.querySelector("[data-collab-waiting]")?.textContent).toBe("waiting for reply…");
  });

  it("shows the reply once it came, as text", async () => {
    const output = JSON.stringify({ delivered: "inserted", status, reply: { replied: true, text: "All <b>green</b>", sentAt: "x" } });
    view = await mount(<SessionCollabToolCard call={send} output={output} isError={false} done projectName="ppm" />);
    expect(view.container.querySelector("[data-collab-waiting]")).toBeNull();
    expect(view.container.textContent).toContain("Write tests");
    expect(view.container.querySelector("[data-collab-reply]")).not.toBeNull();
  });

  it("says why no reply came", async () => {
    const output = JSON.stringify({ delivered: "inserted", status, reply: { replied: false, reason: "timeout" } });
    view = await mount(<SessionCollabToolCard call={send} output={output} isError={false} done projectName="ppm" />);
    expect(view.container.querySelector('[data-collab-no-reply="timeout"]')?.textContent).toBe(waitEndedText({ replied: false, reason: "timeout" }));
  });

  it("names the card the other session is waiting on the user for", async () => {
    const reply = { replied: false, reason: "waiting_for_user", card: { kind: "question", title: "Which branch first?" } };
    const output = JSON.stringify({ delivered: "queued", status, reply });
    view = await mount(<SessionCollabToolCard call={send} output={output} isError={false} done projectName="ppm" />);
    const line = view.container.querySelector('[data-collab-no-reply="waiting_for_user"]');
    expect(line?.textContent).toContain("Which branch first?");
    expect(line?.textContent).toContain("waiting for the user to answer a question");
    // A malformed card is not shown as a reason at all rather than as a half-read one.
    expect(sessionCollabToolResult(JSON.stringify({ delivered: "queued", status, reply: { replied: false, reason: "waiting_for_user" } }))?.reply).toBeUndefined();
  });

  it("says the wait was cancelled, not done, when the turn ended with no result (Stop)", async () => {
    view = await mount(<SessionCollabToolCard call={send} isError={false} done projectName="ppm" />);
    const line = view.container.querySelector('[data-collab-no-reply="cancelled"]');
    expect(line?.textContent).toBe(stoppedCallText(send));
    expect(view.container.textContent).toContain("wait cancelled");
    expect(view.container.querySelector("[data-collab-waiting]")).toBeNull();
    expect(view.container.querySelector(".text-success")).toBeNull();
  });

  it("never shows success for a call without wait that got no result", async () => {
    const create = { tool: "create_session" as const, title: "Helper", task: "t", wait: false };
    view = await mount(<SessionCollabToolCard call={create} isError={false} done projectName="ppm" />);
    expect(view.container.querySelector("[data-collab-no-result]")?.textContent).toBe(stoppedCallText(create));
    expect(view.container.querySelector("[data-collab-no-reply]")).toBeNull();
    expect(view.container.querySelector(".text-success")).toBeNull();
  });

  it("the router passes a stopped turn's completion through as stopped", async () => {
    view = await mount(<ToolCard completed tool={{ type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: target, message: "m", wait: true }, toolUseId: "t2" }} projectName="ppm" />);
    expect(view.container.querySelector('[data-collab-no-reply="cancelled"]')).not.toBeNull();
  });

  it("shows the tool's error", async () => {
    view = await mount(<SessionCollabToolCard call={send} output="Refused: depth limit reached" isError done projectName="ppm" />);
    expect(view.container.textContent).toContain("Refused: depth limit reached");
  });

  it("opens the target session from its button", async () => {
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<SessionCollabToolCard call={send} isError={false} done={false} projectName="ppm" />);
      const button = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Open session")!;
      await click(button);
      expect(openTab.mock.calls[0]![0]).toMatchObject({ type: "chat", metadata: { sessionId: target, projectName: "ppm" } });
    } finally {
      openTab.mockRestore();
    }
  });

  it("shows the created session as it is now, not as it was when the tool answered", async () => {
    const create = { tool: "create_session" as const, title: "Count TS", task: "count", wait: true };
    const running = { ...status, phase: "streaming" as const };
    const output = JSON.stringify({ sessionId: target, title: "Count TS", providerId: "claude", model: null, status: running,
      reply: { replied: true, text: "5 files", sentAt: "x" } });
    useStreamingStore.getState().setStreaming(target, true, "ppm");
    try {
      view = await mount(<SessionCollabToolCard call={create} output={output} isError={false} done projectName="ppm" />);
      await click(view.container.querySelector("button[aria-expanded]"));
      expect(view.container.textContent).toContain("· Running");
      // The child finished: the card follows without a new tool result.
      await act(async () => { useStreamingStore.getState().setStreaming(target, false); });
      expect(view.container.textContent).toContain("· Idle");
      expect(view.container.textContent).not.toContain("· Running");
      // Waiting on the user outranks both.
      await act(async () => { useSessionCollabStore.setState({ pendingApprovals: { [target]: "r1" } }); });
      expect(view.container.textContent).toContain("· Needs approval");
    } finally {
      await act(async () => {
        useStreamingStore.getState().setStreaming(target, false);
        useSessionCollabStore.setState({ pendingApprovals: {} });
      });
    }
  });

  it("is what the tool-card router draws for these tools", async () => {
    view = await mount(<ToolCard tool={{ type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: target, message: "m", wait: true }, toolUseId: "t1" }} projectName="ppm" />);
    expect(view.container.querySelector('[data-session-collab-card="send_to_session"]')).not.toBeNull();
  });
});
