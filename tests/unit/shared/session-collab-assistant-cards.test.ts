/**
 * The PPM Assistant's session-tool cards and messages as every surface reads them: its cards are
 * answered once and never "for the session", Telegram shows the whole message with Allow only when
 * it fits, and the from-session block names the Assistant and survives a round trip.
 */
import { describe, expect, it } from "bun:test";
import {
  SESSION_COLLAB_APPROVAL, sessionCollabAnswersFor, sessionCollabApprovalInput, type SessionCollabMessageApproval,
} from "../../../src/shared/session-collab.ts";
import {
  decodeFromSession, encodeFromSession, fromSessionHeaderLine, type FromSessionReference,
} from "../../../src/shared/chat-from-session.ts";
import { decidingInput } from "../../../src/services/chat-control/approval-deciding-input.ts";
import { formatApprovalCard } from "../../../src/services/assistant-telegram/assistant-telegram-card-format.ts";

const message: SessionCollabMessageApproval = {
  kind: "message", targetSessionId: "b0000000-0000-4000-8000-000000000002", targetTitle: "Fix login", projectName: "api",
  providerId: "claude", permissionMode: "bypassPermissions", modeSource: "stored", message: "run the tests\nand report",
};
const card = (input: unknown) => ({ requestId: "r1", tool: SESSION_COLLAB_APPROVAL, input, isQuestion: false });

describe("the Assistant's cards", () => {
  it("offer Allow once and Deny only", () => {
    expect(sessionCollabAnswersFor(message)).toEqual(["allow_once", "deny"]);
    const create = { kind: "create" as const, title: "T", providerId: "claude", model: null, task: "x", depth: 0 };
    expect(sessionCollabAnswersFor({ ...create, askedBy: "assistant" })).toEqual(["allow_once", "deny"]);
    // An ordinary session's create card still offers "for this session".
    expect(sessionCollabAnswersFor(create)).toEqual(["allow_once", "allow_session", "deny"]);
    expect(sessionCollabApprovalInput(SESSION_COLLAB_APPROVAL, message)).toEqual(message);
  });

  it("show the whole message, the chat, its project and a bypass warning to every surface", () => {
    const d = decidingInput(card(message));
    expect(d).toMatchObject({ kind: "endpoint", complete: true, text: "run the tests\nand report", label: "Message" });
    expect(d.title).toContain('chat in "api"');
    expect(d.facts).toContainEqual({ label: "Chat", value: `Fix login (${message.targetSessionId})` });
    expect(d.facts.find((f) => f.label === "Warning")?.value).toContain("without asking");
  });

  it("carry Allow on Telegram only when the whole message fits", () => {
    expect(formatApprovalCard(card(message), "PPM Assistant wants to").allow).toBe(true);
    const long = formatApprovalCard(card({ ...message, message: "x".repeat(5000) }), "PPM Assistant wants to");
    expect(long.allow).toBe(false);
  });
});

describe("a from-session block from the Assistant", () => {
  const ref: FromSessionReference = {
    version: 1, sessionId: "a0000000-0000-4000-8000-000000000001", providerId: "claude", projectName: "__assistant__",
    title: "Ops", sentAt: "2026-11-10T00:00:00.000Z", kind: "assistant",
  };

  it("tells the receiving AI it is the Assistant, not the user, and that it cannot reply through the tools", () => {
    const header = fromSessionHeaderLine(ref);
    expect(header).toStartWith("Message from PPM Assistant, another AI");
    expect(header).toContain("not the user");
    expect(header).not.toContain("Reply with send_to_session");
  });

  it("decodes back to the same sender, and a forged kind does not decode", () => {
    const encoded = encodeFromSession("hello", ref);
    expect(decodeFromSession(encoded)).toEqual({ content: "hello", fromSession: ref });
    const forged = encoded.replace('"kind":"assistant"', '"kind":"victor"');
    expect(decodeFromSession(forged).fromSession).toBeNull();
  });
});
