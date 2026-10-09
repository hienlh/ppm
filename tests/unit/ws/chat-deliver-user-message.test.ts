/**
 * A message the PPM Assistant sends into one of the user's chats: it reaches every device
 * showing that chat, makes none of them "the chatting device", runs in the mode the approval
 * card stated (the chat's saved mode, or the one its running session started in) and nothing
 * else, and is refused rather than answering a card that chat is waiting on — or when the
 * target is an Assistant chat. Every chat now keeps the mode its user last picked.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { chatWebSocket, deliverToChattingDevice } from "../../../src/server/ws/chat.ts";
import { getSessionPermissionMode, setSessionAssistant, setSessionPermissionMode } from "../../../src/services/db.service.ts";
import { assistantChatDelivery, TARGET_HAS_PENDING_APPROVAL } from "../../../src/services/assistant-mcp/assistant-chat-send.ts";

let root: string;
let savedProjects: unknown;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-deliver-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "web", path: root }]);
});
afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(root, { recursive: true, force: true });
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5); };

/** A chat whose provider records each turn, optionally holding it open, optionally asking first. */
async function chat(opts: { hold?: boolean; events?: object[] } = {}) {
  const s = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const turns: Array<{ content: string; opts: any }> = [];
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* (_p: string, _s: string, content: string, o: any) {
    turns.push({ content, opts: o });
    yield { type: "text", content: "on it" } as any;
    for (const e of opts.events ?? []) yield e as any;
    if (opts.hold) await gate;
    yield { type: "done", sessionId: s.id } as any;
  } as any);
  const resolved = spyOn(chatService, "resolveApproval").mockImplementation(() => {});
  const sockets: any[] = [];
  const connect = () => {
    const messages: any[] = [];
    const socket = { data: { sessionId: s.id, projectName: "web" }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages, of: (type: string) => messages.filter((m) => m.type === type) };
  };
  cleanups.push(() => {
    release();
    send.mockRestore();
    resolved.mockRestore();
    for (const sock of sockets) chatWebSocket.close(sock);
  });
  const target = { sessionId: s.id, projectName: "web", providerId: "mock" };
  return { id: s.id, connect, turns, resolved, target, release };
}

const delivery = () => {
  const d = assistantChatDelivery();
  if (!d) throw new Error("the chat socket layer registered no delivery");
  return d;
};

it("reaches every device showing the chat, and makes none of them the chatting device", async () => {
  const c = await chat();
  setSessionPermissionMode(c.id, "acceptEdits");
  const phone = c.connect();
  const laptop = c.connect();
  const result = await delivery().deliver(c.target, "run the tests", "acceptEdits");
  expect(result).toEqual({ ok: true, sessionId: c.id });
  for (const device of [phone, laptop]) {
    expect(device.of("user_message")).toHaveLength(1);
    expect(device.of("user_message")[0].content).toBe("run the tests");
  }
  await until(() => c.turns.length === 1);
  expect(c.turns[0]).toMatchObject({ content: "run the tests", opts: { permissionMode: "acceptEdits", origin: "assistant" } });
  // No device sent it, so a strict UI request still has nobody to go to.
  expect(deliverToChattingDevice(c.id, { type: "probe" }, { strict: true })).toBe(0);
});

it("leaves the device the user is chatting from as it was", async () => {
  const c = await chat();
  const phone = c.connect();
  const laptop = c.connect();
  await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "hello", permissionMode: "plan" }));
  await until(() => c.turns.length === 1);
  await until(() => phone.of("phase_changed").some((m) => m.phase === "idle"));
  expect((await delivery().deliver(c.target, "and this", "plan")).ok).toBe(true);
  await until(() => c.turns.length === 2);
  expect(deliverToChattingDevice(c.id, { type: "probe" }, { strict: true })).toBe(1);
  expect(phone.of("probe")).toHaveLength(1);
  expect(laptop.of("probe")).toHaveLength(0);
});

it("states and runs the chat's saved mode, and refuses any other", async () => {
  const c = await chat();
  setSessionPermissionMode(c.id, "acceptEdits");
  expect(delivery().inspect(c.id, "mock")).toEqual({ mode: "acceptEdits", source: "stored", pendingApproval: false });
  const refused = await delivery().deliver(c.target, "rm -rf node_modules", "bypassPermissions");
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("acceptEdits");
  await Bun.sleep(20);
  expect(c.turns).toHaveLength(0);
});

it("states the mode a running session started in, since a message joins that session", async () => {
  const c = await chat({ hold: true });
  setSessionPermissionMode(c.id, "default");
  const phone = c.connect();
  await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "start", permissionMode: "bypassPermissions" }));
  await until(() => c.turns.length === 1);
  // The user's pick is now saved for every chat, not only design ones.
  expect(getSessionPermissionMode(c.id)).toBe("bypassPermissions");
  expect(delivery().inspect(c.id, "mock")).toMatchObject({ mode: "bypassPermissions", source: "running" });
});

it("is refused while the chat waits on an approval, and leaves that approval alone", async () => {
  const c = await chat({ hold: true, events: [{ type: "approval_request", requestId: "card-1", tool: "Bash", input: { command: "ls" } }] });
  const phone = c.connect();
  await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "go", permissionMode: "default" }));
  await until(() => phone.of("approval_request").length === 1);
  expect(delivery().inspect(c.id, "mock").pendingApproval).toBe(true);
  const result = await delivery().deliver(c.target, "also do this", "default");
  expect(result).toEqual({ ok: false, error: TARGET_HAS_PENDING_APPROVAL });
  expect(c.resolved).not.toHaveBeenCalled();
  expect(phone.of("approval_resolved")).toHaveLength(0);
  expect(phone.of("user_message")).toHaveLength(0);
  await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "ready" }));
  expect(phone.of("session_state").at(-1).pendingApproval.requestId).toBe("card-1");
});

it("never sends into an Assistant chat", async () => {
  const c = await chat();
  setSessionAssistant(c.id);
  const result = await delivery().deliver(c.target, "hi", "default");
  expect(result.ok).toBe(false);
  await Bun.sleep(20);
  expect(c.turns).toHaveLength(0);
});

it("runs in a chat nobody has open, so whoever opens it later sees the turn", async () => {
  const c = await chat();
  const mode = delivery().inspect(c.id, "mock");
  expect(mode.source).toBe("provider-default");
  expect((await delivery().deliver(c.target, "summarise the repo", mode.mode)).ok).toBe(true);
  await until(() => c.turns.length === 1);
  expect(c.turns[0]!.opts).toMatchObject({ permissionMode: mode.mode, origin: "assistant" });
});
