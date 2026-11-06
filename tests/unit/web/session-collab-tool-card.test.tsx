/**
 * The session tools' card: recognised under either provider's name, waiting while a wait is in
 * flight, the reply once it came, why none did, the tool's error, and an Open session button.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import {
  sessionCollabToolCall, sessionCollabToolResult, waitEndedText,
} from "../../../src/web/lib/session-collab-tool-call";
import type { SessionStatus } from "../../../src/shared/session-collab";

installDom();
afterAll(uninstallDom);
const { SessionCollabToolCard } = await import("../../../src/web/components/chat/session-collab-tool-card");
const { ToolCard } = await import("../../../src/web/components/chat/tool-cards");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");

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
    expect(view.container.querySelector('[data-collab-no-reply="timeout"]')?.textContent).toBe(waitEndedText("timeout"));
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

  it("is what the tool-card router draws for these tools", async () => {
    view = await mount(<ToolCard tool={{ type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: target, message: "m", wait: true }, toolUseId: "t1" }} projectName="ppm" />);
    expect(view.container.querySelector('[data-session-collab-card="send_to_session"]')).not.toBeNull();
  });
});
