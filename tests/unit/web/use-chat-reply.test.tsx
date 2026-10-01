import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import { encodeReply, decodeReply, type ReplyReference } from "../../../src/shared/chat-reply";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { api } = await import("../../../src/web/lib/api-client");
let chat: ReturnType<typeof useChat>;
let view: Mounted | null = null;
let receive: (event: MessageEvent) => void;
let rejected: unknown[];
const reply: ReplyReference = { version: 1, sessionId: "session", providerId: "claude", messageId: "source", role: "assistant", timestamp: "2026-10-01T00:00:00Z", quote: "Choose option two", truncated: false };
let send: ReturnType<typeof spyOn>;
let connect: ReturnType<typeof spyOn>;
let onMessage: ReturnType<typeof spyOn>;
let get: ReturnType<typeof spyOn>;
function Probe() {
  chat = useChat("session", "claude", "proj", undefined, undefined, { onMessageRejected: (event) => rejected.push(event) });
  return null;
}
async function emit(frame: unknown) {
  await act(async () => receive(new MessageEvent("message", { data: JSON.stringify(frame) })));
}
beforeEach(async () => {
  rejected = [];
  connect = spyOn(WsClient.prototype, "connect").mockImplementation(() => {});
  send = spyOn(WsClient.prototype, "send").mockImplementation(() => {});
  onMessage = spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; });
  get = spyOn(api, "get").mockResolvedValue([]);
  view = await mount(<Probe />);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  send.mockRestore(); connect.mockRestore(); onMessage.mockRestore(); get.mockRestore();
});
it("sends raw body and reply separately while preserving the snapshot in the optimistic transcript", async () => {
  await act(async () => chat.sendMessage("do it", { replyTo: reply, priority: "later", imagePaths: ["new.png"] }));
  expect(decodeReply(chat.messages.at(-1)!.content)).toEqual({ content: "do it", replyTo: reply });
  expect(JSON.parse(send.mock.calls.at(-1)![0] as string)).toMatchObject({ type: "message", content: "do it", replyTo: reply, priority: "later", imagePaths: ["new.png"] });
});
it("keeps encoded edits intact and renders a remote echo with its snapshot", async () => {
  const encoded = encodeReply("edited", reply);
  await act(async () => chat.sendMessage(encoded));
  expect(chat.messages.at(-1)!.content).toBe(encoded);
  await emit({ type: "user_message", content: encodeReply("other device", reply) });
  expect(decodeReply(chat.messages.at(-1)!.content)).toEqual({ content: "other device", replyTo: reply });
});
it("removes a rejected optimistic message and returns body and quote for draft recovery", async () => {
  await act(async () => chat.sendMessage("/clear", { replyTo: reply }));
  await emit({ type: "message_rejected", content: "/clear", replyTo: reply, message: "Cancel reply first" });
  expect(chat.messages).toHaveLength(0);
  expect(chat.phase).toBe("idle");
  expect(rejected).toEqual([{ content: "/clear", replyTo: reply, message: "Cancel reply first" }]);
});
it("keeps an active turn running when its follow-up is rejected", async () => {
  await emit({ type: "phase_changed", phase: "thinking" });
  await emit({ type: "text", content: "Before " });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 110)); });
  await act(async () => chat.sendMessage("/clear", { replyTo: reply }));
  await emit({ type: "message_rejected", content: "/clear", replyTo: reply, message: "Cancel reply first" });
  await emit({ type: "text", content: "after" });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 110)); });
  expect(chat.phase).toBe("thinking");
  expect(chat.messages).toHaveLength(1);
  expect(chat.messages[0]!.content).toBe("Before after");
});

it("rejects the newest identical send rather than deleting an earlier accepted message", async () => {
  await act(async () => chat.sendMessage("same", { replyTo: reply }));
  const firstId = chat.messages[0]!.id;
  await emit({ type: "phase_changed", phase: "idle" });
  await act(async () => chat.sendMessage("same", { replyTo: reply }));
  await emit({ type: "message_rejected", content: "same", replyTo: reply, message: "Invalid reply" });
  expect(chat.messages).toHaveLength(1);
  expect(chat.messages[0]!.id).toBe(firstId);
  expect(rejected).toHaveLength(1);
});

it("correlates rejection to the exact request among identical concurrent sends", async () => {
  await act(async () => chat.sendMessage("same", { replyTo: reply }));
  const first = JSON.parse(send.mock.calls.at(-1)![0] as string);
  await act(async () => chat.sendMessage("same", { replyTo: reply }));
  const second = JSON.parse(send.mock.calls.at(-1)![0] as string);
  expect(first.clientMessageId).not.toBe(second.clientMessageId);
  await emit({ type: "message_rejected", clientMessageId: first.clientMessageId, content: "same", replyTo: reply, message: "First rejected" });
  expect(chat.messages.map((message) => message.id)).toEqual([second.clientMessageId]);
  await emit({ type: "message_rejected", clientMessageId: second.clientMessageId, content: "same", replyTo: reply, message: "Second rejected" });
  expect(chat.messages.filter((message) => message.role === "user")).toHaveLength(0);
  expect(rejected).toHaveLength(2);
});
