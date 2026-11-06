/**
 * A linked session's status after a reload, when only the unread mark says a card waits on the
 * user, and the links a refused `send_to_session` must not add.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";
import { collectLinkedSessions, linkedSessionStatus } from "../../../src/web/lib/linked-sessions";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
const { notificationColor, notificationTint } = await import("../../../src/web/stores/notification-store");

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "cccccccc-2222-4000-8000-000000000002";
const TYPED = "dddddddd-3333-4000-8000-000000000003";

describe("linked session status", () => {
  it("reads a pending session card that only the unread mark remembers as needing the user", () => {
    const notifications = new Map([[CHILD, { count: 1, type: "collab_approval" }]]);
    expect(linkedSessionStatus(CHILD, { streaming: new Map(), notifications, pendingApprovals: {} })).toBe("needs_approval");
    expect(notificationColor("collab_approval")).toBe(notificationColor("approval_request"));
    expect(notificationTint("collab_approval")).toBe(notificationTint("approval_request"));
  });
});

describe("links from send_to_session calls", () => {
  const answered = (sessionId: string, output: string, isError?: boolean): ChatMessage => ({
    id: "1", role: "assistant", timestamp: "", content: "",
    events: [
      { type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: sessionId, message: "hi" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", output, ...(isError ? { isError } : {}) },
    ] as ChatMessage["events"],
  });

  it("adds no link for a send the server refused", () => {
    const messages = [answered(TYPED, "No PPM session with that id is known in this project.", true)];
    expect(collectLinkedSessions({ sessionId: ME, list: [], messages })).toEqual([]);
  });

  it("links the session a delivered send reached, as the server named it", () => {
    const status = {
      sessionId: CHILD, title: "Tests", providerId: "codex", model: null, phase: "idle", waitingFor: null,
      spawnedBy: null, depth: 0, lastAssistantText: null, unreadReplies: 0, updatedAt: null,
    };
    const messages = [answered(CHILD, JSON.stringify({ delivered: "started", status }))];
    expect(collectLinkedSessions({ sessionId: ME, list: [], messages })).toEqual([
      { sessionId: CHILD, title: "Tests", providerId: "codex", relations: ["messaged"] },
    ]);
  });
});
