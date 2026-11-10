/**
 * A message the PPM Assistant sends into one of the user's chats, as the chat socket layer sees it:
 * the card states the mode the chat would run it in (its saved mode, or the one its running session
 * started in), and the message then comes in through the session tools' door — on every device
 * showing the chat, marked as the Assistant's, heard by the server's own listeners as a message from
 * another session, and started in the chat's own project when nobody has it open.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { chatTargetMode, chatWebSocket, collabLiveState } from "../../../src/server/ws/chat.ts";
import { deliverToSession } from "../../../src/server/ws/chat-inject.ts";
import { getSessionPermissionMode, setSessionAssistant, setSessionPermissionMode } from "../../../src/services/db.service.ts";
import { chatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { decodeMessageBlocks } from "../../../src/shared/chat-message-blocks.ts";
import type { FromSessionReference } from "../../../src/shared/chat-from-session.ts";

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

const ASSISTANT: FromSessionReference = {
  version: 1, sessionId: "a0000000-0000-4000-8000-0000000000aa", providerId: "claude", projectName: "__assistant__",
  title: "Ops", sentAt: new Date().toISOString(), kind: "assistant",
};

/** A chat whose provider records each turn, optionally holding it open. */
async function chat(opts: { hold?: boolean } = {}) {
  const s = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const turns: Array<{ content: string; opts: any }> = [];
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* (_p: string, _s: string, content: string, o: any) {
    turns.push({ content, opts: o });
    yield { type: "text", content: "on it" } as any;
    if (opts.hold) await gate;
    yield { type: "done", sessionId: s.id } as any;
  } as any);
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
    for (const sock of sockets) chatWebSocket.close(sock);
  });
  return { id: s.id, connect, turns };
}

const fromAssistant = (id: string, body: string) => deliverToSession({
  targetSessionId: id, providerId: "mock", projectName: "web", projectPath: root, body, fromSession: { ...ASSISTANT, sentAt: new Date().toISOString() },
});

it("states the chat's saved mode, else the one its running session started in", async () => {
  const c = await chat({ hold: true });
  setSessionPermissionMode(c.id, "acceptEdits");
  expect(chatTargetMode(c.id, "mock")).toEqual({ mode: "acceptEdits", source: "stored" });
  const phone = c.connect();
  await chatWebSocket.message(phone.socket as any, JSON.stringify({ type: "message", content: "start", permissionMode: "bypassPermissions" }));
  await until(() => c.turns.length === 1);
  expect(getSessionPermissionMode(c.id)).toBe("bypassPermissions");
  expect(chatTargetMode(c.id, "mock")).toMatchObject({ mode: "bypassPermissions", source: "running" });
});

it("reaches every device as the Assistant's message, and server listeners hear it from a session", async () => {
  const c = await chat();
  const phone = c.connect();
  const laptop = c.connect();
  const heard: Array<{ sessionId: string; origin: string }> = [];
  cleanups.push(chatLifecycle.on("user_message", (p) => heard.push(p)));
  const out = await fromAssistant(c.id, "run the tests");
  expect(out.delivered).toBe("started");
  await until(() => c.turns.length === 1);
  for (const device of [phone, laptop]) {
    const echoed = device.of("user_message");
    expect(echoed).toHaveLength(1);
    const decoded = decodeMessageBlocks(echoed[0].content);
    expect(decoded.content).toBe("run the tests");
    expect(decoded.fromSession).toMatchObject({ sessionId: ASSISTANT.sessionId, kind: "assistant" });
  }
  expect(c.turns[0]!.opts).toMatchObject({ origin: "session" });
  expect(heard).toContainEqual(expect.objectContaining({ sessionId: c.id, origin: "session" }));
});

it("delivers nothing when the chat would now run it in another mode than the one approved", async () => {
  const c = await chat();
  setSessionPermissionMode(c.id, "acceptEdits");
  const approvedIn = (expectedMode: string) => deliverToSession({
    targetSessionId: c.id, providerId: "mock", projectName: "web", projectPath: root, body: "go",
    fromSession: { ...ASSISTANT, sentAt: new Date().toISOString() }, expectedMode,
  });
  await expect(approvedIn("plan")).rejects.toThrow("the mode the user approved");
  expect(c.turns).toHaveLength(0);
  expect((await approvedIn("acceptEdits")).delivered).toBe("started");
});

it("never delivers into a PPM Assistant session", async () => {
  const c = await chat();
  setSessionAssistant(c.id);
  await expect(fromAssistant(c.id, "hi")).rejects.toThrow("PPM Assistant");
  await Bun.sleep(20);
  expect(c.turns).toHaveLength(0);
});

it("starts a chat nobody has open in its own project", async () => {
  const c = await chat();
  expect(collabLiveState(c.id)).toBeNull();
  expect((await fromAssistant(c.id, "summarise the repo")).delivered).toBe("started");
  await until(() => c.turns.length === 1);
  expect(collabLiveState(c.id)).toMatchObject({ projectName: "web", projectPath: root });
});
