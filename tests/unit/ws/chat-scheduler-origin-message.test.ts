/**
 * A script schedule posts into a chat through the chat socket handler with `ws.data.origin` set
 * (`schedule-script/chat-loopback.ts`). That is not the person writing: it must not reset the
 * session's pair limits or end its session-tool waits, and its turn is traced under its own origin.
 * A browser socket (no origin) still does both.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { pairCounter } from "../../../src/services/session-collab/pair-counter.ts";
import { collabWaits } from "../../../src/services/session-collab/collab-waits.ts";

const OTHER_SESSION = "00000000-0000-4000-8000-000000000042";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

async function messageFrom(origin: "scheduler" | undefined) {
  const session = await chatService.createSession("mock", {});
  const origins: unknown[] = [];
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* (_p: string, _s: string, _c: string, opts?: { origin?: unknown }) {
    origins.push(opts?.origin);
    yield { type: "done" } as any;
  } as any);
  const cancel = spyOn(collabWaits, "cancelWaiter");
  spies.push(send, cancel);
  pairCounter.record(session.id, OTHER_SESSION);
  pairCounter.record(session.id, OTHER_SESSION);

  const socket = { data: { sessionId: session.id, ...(origin ? { origin } : {}) }, send: () => {} };
  chatWebSocket.open(socket as any);
  try {
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "status check" }));
    for (let i = 0; i < 100 && origins.length === 0; i++) await Bun.sleep(5);
  } finally {
    chatWebSocket.close(socket as any);
  }
  return { session, origins, cancel };
}

it("a script schedule's message leaves pair limits and waits alone, and is traced as the scheduler", async () => {
  const { session, origins, cancel } = await messageFrom("scheduler");
  expect(origins).toEqual(["scheduler"]);
  expect(pairCounter.count(session.id, OTHER_SESSION)).toBe(2);
  expect(cancel).not.toHaveBeenCalled();
});

it("a browser message resets the session's pair limits and ends its waits", async () => {
  const { session, origins, cancel } = await messageFrom(undefined);
  expect(origins).toEqual(["ws"]);
  expect(pairCounter.count(session.id, OTHER_SESSION)).toBe(0);
  expect(cancel).toHaveBeenCalledWith(session.id);
});
