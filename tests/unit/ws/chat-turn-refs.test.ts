/**
 * Turn references at the chat socket, the one door that grants them: an empty list is no list,
 * a built-in command hands them back like it does a reply, both blocks travel in one message,
 * and the sender is told the text exactly as it was stored so its own bubble matches it.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { turnGrantsFor } from "../../../src/services/session-turns/turn-grant-ledger.ts";
import { decodeMessageBlocks, encodeMessageBlocks } from "../../../src/shared/chat-message-blocks.ts";
import type { TurnReference } from "../../../src/shared/chat-turn-ref.ts";
import type { ReplyReference } from "../../../src/shared/chat-reply.ts";

const PROJECT = { name: "turn-refs-unit", path: process.env.PPM_HOME! };
const ref: TurnReference = {
  version: 1, projectName: PROJECT.name, providerId: "codex", sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
  turnId: "bbbbbbbb-1111-4000-8000-000000000001", n: 2, title: "Other chat", prompt: "fix the build", at: "2026-11-01T08:00:00.000Z",
};

const restores: Array<() => void> = [];
const sockets: any[] = [];
beforeAll(() => {
  configService.set("projects", [...configService.get("projects").filter((p) => p.name !== PROJECT.name), PROJECT]);
});
afterAll(() => {
  configService.set("projects", configService.get("projects").filter((p) => p.name !== PROJECT.name));
});
afterEach(() => {
  for (const socket of sockets.splice(0)) chatWebSocket.close(socket);
  for (const restore of restores.splice(0)) restore();
});

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { sessionId }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as any);
  return { socket, messages };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The provider receives each message's final text; every turn ends at once. */
function captureProvider(): string[] {
  const received: string[] = [];
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation(async function* (sessionId: string, message: string) {
    received.push(message);
    yield { type: "done", sessionId };
  } as never);
  restores.push(() => send.mockRestore());
  return received;
}

it("treats an empty list as no references, and acks the stored text to the sender", async () => {
  const received = captureProvider();
  const session = await chatService.createSession("mock", {});
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "plain", clientMessageId: "c-empty", turnRefs: [] }));
  await until(() => received.length === 1, "the provider call");
  expect(live.messages.some((m) => m.type === "message_rejected")).toBe(false);
  expect(received[0]).toBe("plain");
  expect(live.messages.find((m) => m.type === "message_accepted")).toEqual({ type: "message_accepted", clientMessageId: "c-empty", content: "plain" });
  expect(turnGrantsFor(session.id)).toEqual([]);
});

it("carries a reply and turn references in one message, in their fixed order, and acks exactly that", async () => {
  const received = captureProvider();
  const session = await chatService.createSession("mock", {});
  const reply: ReplyReference = { version: 1, sessionId: session.id, providerId: "mock", messageId: "m1", role: "assistant", timestamp: "2026-11-01T00:00:00Z", quote: "earlier answer", truncated: false };
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "compare these", clientMessageId: "c-both", replyTo: reply, turnRefs: [ref] }));
  await until(() => received.length === 1, "the provider call");
  const decoded = decodeMessageBlocks(received[0]!);
  expect(decoded).toEqual({ content: "compare these", replyTo: reply, turnRefs: [ref], fromSession: null });
  expect(received[0]).toBe(encodeMessageBlocks("compare these", { turnRefs: [ref], replyTo: reply }));
  const ack = live.messages.find((m) => m.type === "message_accepted");
  expect(ack).toEqual({ type: "message_accepted", clientMessageId: "c-both", content: received[0] });
  expect(turnGrantsFor(session.id).map((g) => g.turnId)).toEqual([ref.turnId]);
});

it("hands references back on a built-in command, grants nothing and runs nothing", async () => {
  const received = captureProvider();
  const session = await chatService.createSession("mock", {});
  const live = connect(session.id);
  await chatWebSocket.message(live.socket as any, JSON.stringify({ type: "message", content: "/version", clientMessageId: "c-slash", turnRefs: [ref] }));
  const rejected = live.messages.find((m) => m.type === "message_rejected");
  expect(rejected).toMatchObject({ clientMessageId: "c-slash", content: "/version", turnRefs: [ref] });
  expect(rejected.message).toContain("built-in command");
  expect(live.messages.some((m) => m.type === "message_accepted")).toBe(false);
  expect(received).toEqual([]);
  expect(turnGrantsFor(session.id)).toEqual([]);
});

it("tells another device which browser id the echoed message was sent under", async () => {
  captureProvider();
  const session = await chatService.createSession("mock", {});
  const sender = connect(session.id);
  const other = connect(session.id);
  await chatWebSocket.message(sender.socket as any, JSON.stringify({ type: "message", content: "hello", clientMessageId: "c-echo", turnRefs: [ref] }));
  await until(() => other.messages.some((m) => m.type === "user_message"), "the echo");
  const echo = other.messages.find((m) => m.type === "user_message");
  expect(echo.clientMessageId).toBe("c-echo");
  expect(decodeMessageBlocks(echo.content).turnRefs).toEqual([ref]);
  // The ack goes to the sender alone.
  expect(other.messages.some((m) => m.type === "message_accepted")).toBe(false);
});
