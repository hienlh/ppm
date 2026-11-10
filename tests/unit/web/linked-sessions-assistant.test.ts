/**
 * The PPM Assistant belongs to no project, so a project chat's linked-sessions bar never lists it
 * (it could only open it as one of that project's chats); the message's own bubble links back. Its
 * tool results name the project of the chat they reached, which is where the tool card opens it.
 */
import { describe, expect, it } from "bun:test";
import { collectLinkedSessions } from "../../../src/web/lib/linked-sessions.ts";
import { sessionCollabToolResult } from "../../../src/web/lib/session-collab-tool-call.ts";
import { encodeFromSession, type FromSessionReference } from "../../../src/shared/chat-from-session.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

const SELF = "b0000000-0000-4000-8000-000000000002";
const sender = (kind?: "assistant"): FromSessionReference => ({
  version: 1, sessionId: kind ? "a0000000-0000-4000-8000-000000000001" : "c0000000-0000-4000-8000-000000000003",
  providerId: "claude", projectName: kind ? "__assistant__" : "api", title: kind ? "Ops" : "Planner",
  sentAt: "2026-11-10T00:00:00.000Z", ...(kind ? { kind } : {}),
});
const userMessage = (from: FromSessionReference): ChatMessage =>
  ({ id: from.sessionId, role: "user", content: encodeFromSession("hi", from), timestamp: from.sentAt }) as ChatMessage;

describe("linked sessions and the PPM Assistant", () => {
  it("lists a session that messaged this chat, but never the Assistant", () => {
    const linked = collectLinkedSessions({ sessionId: SELF, list: [], messages: [userMessage(sender("assistant")), userMessage(sender())] });
    expect(linked.map((l) => l.sessionId)).toEqual([sender().sessionId]);
  });

  it("reads the project an Assistant's tool result names", () => {
    const out = JSON.stringify({ delivered: "started", project: "api", status: { sessionId: SELF, phase: "idle", title: "Fix login" } });
    expect(sessionCollabToolResult(out)).toMatchObject({ sessionId: SELF, project: "api" });
    expect(sessionCollabToolResult(JSON.stringify({ delivered: "started" }))?.project).toBeUndefined();
  });
});
