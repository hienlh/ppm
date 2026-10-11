/**
 * How a turn's end reaches server-side listeners: once per turn, after the chat is idle, as
 * `done`, `stopped` (an error or a limit ended it, or it ended with no `done` at all) or `failed`
 * (the provider threw) — and under the id the provider renamed the session to.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { chatControl } from "../../../src/services/chat-control/chat-control.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); };

/** A session whose provider runs `script` for its turn, with one browser attached. */
async function session(script: (sessionId: string) => AsyncGenerator<object>) {
  const s = await chatService.createSession("mock", {});
  const send = spyOn(chatService, "sendMessage").mockImplementation(((_p: string, sessionId: string) => script(sessionId)) as any);
  const ended: Array<ChatLifecycleEvents["turn_ended"]> = [];
  const migrated: Array<ChatLifecycleEvents["migrated"]> = [];
  const offEnded = chatLifecycle.on("turn_ended", (p) => ended.push(p));
  const offMigrated = chatLifecycle.on("migrated", (p) => migrated.push(p));
  const socket = { data: { sessionId: s.id, projectName: "web" }, send: () => {} };
  chatWebSocket.open(socket as any);
  cleanups.push(() => { send.mockRestore(); offEnded(); offMigrated(); chatWebSocket.close(socket as any); });
  await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "go" }));
  return { id: s.id, ended, migrated };
}

it("reports a provider that throws mid-turn as failed, with its error, once the chat is idle", async () => {
  const s = await session(async function* () {
    yield { type: "text", content: "starting" };
    throw new Error("subprocess died");
  });
  await until(() => s.ended.length > 0);
  await Bun.sleep(30);
  expect(s.ended).toHaveLength(1);
  expect(s.ended[0]).toMatchObject({ sessionId: s.id, outcome: "failed", error: "subprocess died" });
  expect(chatControl()?.liveState(s.id)?.running).toBe(false);
});

it("reports a turn whose stream ends without a done as stopped", async () => {
  const s = await session(async function* () {
    yield { type: "text", content: "half an answer" };
  });
  await until(() => s.ended.length > 0);
  await Bun.sleep(30);
  expect(s.ended).toEqual([expect.objectContaining({ sessionId: s.id, outcome: "stopped" })]);
});

it("reports a finished turn once, with its answer, and nothing more when the stream then closes", async () => {
  const s = await session(async function* (sessionId) {
    yield { type: "text", content: "All done." };
    yield { type: "done", sessionId };
  });
  await until(() => s.ended.length > 0);
  await Bun.sleep(30);
  expect(s.ended).toEqual([expect.objectContaining({ sessionId: s.id, outcome: "done", finalText: "All done." })]);
});

it("announces a provider's rename and ends the turn under the new id", async () => {
  const renamed = `thread-${crypto.randomUUID()}`;
  const s = await session(async function* (sessionId) {
    yield { type: "session_migrated", oldSessionId: sessionId, newSessionId: renamed };
    yield { type: "text", content: "hi" };
    yield { type: "done", sessionId: renamed };
  });
  await until(() => s.ended.length > 0);
  expect(s.migrated).toEqual([{ oldSessionId: s.id, newSessionId: renamed }]);
  expect(s.ended[0]).toMatchObject({ sessionId: renamed, outcome: "done" });
  expect(chatControl()?.liveState(s.id)?.phase).toBe("idle");
});
