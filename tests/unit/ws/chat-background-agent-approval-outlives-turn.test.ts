/**
 * A provider's approval request is not tied to the turn it arrives in: a background agent asks
 * whenever it gets there, and its tool call keeps waiting after the foreground turn ends. Its
 * card must survive that turn's `done` — still shown to a device that reconnects, and still
 * answerable — until it is answered, pushed aside by a message, or the session goes.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); };

/** A provider stream driven by hand, behind one chat socket. */
async function harness() {
  const s = await chatService.createSession("mock", {});
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const emit = (...evs: any[]) => { queue.push(...evs); const w = wake; wake = null; w?.(); };
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    while (!ended) {
      while (queue.length) yield queue.shift();
      await new Promise<void>((r) => { wake = r; });
    }
  } as any);
  const resolved = spyOn(chatService, "resolveApproval").mockImplementation(() => {});
  const messages: any[] = [];
  const socket = { data: { sessionId: s.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  const say = (msg: object) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  cleanups.push(() => { ended = true; wake?.(); send.mockRestore(); resolved.mockRestore(); chatWebSocket.close(socket as any); });
  return { id: s.id, emit, say, resolved, of: (type: string) => messages.filter((m) => m.type === type) };
}

/** Turn 1 launches a background agent; during turn 2 the agent asks to run Bash, and turn 2 ends first. */
async function cardOutlivingTurn() {
  const h = await harness();
  await h.say({ type: "message", content: "start a background agent" });
  h.emit({ type: "text", content: "Agent launched." }, { type: "done", sessionId: h.id });
  await until(() => h.of("phase_changed").some((p) => p.phase === "idle"));
  await h.say({ type: "message", content: "meanwhile, explain X" });
  h.emit({ type: "approval_request", requestId: "bg-1", tool: "Bash", input: { command: "npm test" } });
  await until(() => h.of("approval_request").length === 1);
  h.emit({ type: "text", content: "X is ..." }, { type: "done", sessionId: h.id });
  await until(() => h.of("phase_changed").filter((p) => p.phase === "idle").length >= 2);
  return h;
}

it("a background agent's card that outlives a later turn can still be answered", async () => {
  const h = await cardOutlivingTurn();
  // Nothing took the card away: no device was told it went, and the provider was refused nothing.
  expect(h.of("approval_resolved")).toEqual([]);
  expect(h.resolved).not.toHaveBeenCalled();
  await h.say({ type: "approval_response", requestId: "bg-1", approved: true });
  expect(h.of("approval_stale")).toEqual([]);
  expect(h.resolved.mock.calls.map((c: any[]) => [c[2], c[3]])).toEqual([["bg-1", true]]);
  expect(h.of("approval_resolved").map((m) => [m.requestId, m.approved])).toEqual([["bg-1", true]]);
});

it("shows a reconnecting device the card still waiting after the turn ended", async () => {
  const h = await cardOutlivingTurn();
  await h.say({ type: "ready" });
  expect(h.of("session_state").at(-1).pendingApproval?.requestId).toBe("bg-1");
});

it("still ends the card when the user sends another message instead of answering", async () => {
  const h = await cardOutlivingTurn();
  await h.say({ type: "message", content: "never mind" });
  expect(h.resolved.mock.calls.map((c: any[]) => [c[2], c[3]])).toEqual([["bg-1", false]]);
  expect(h.of("approval_resolved").map((m) => [m.requestId, m.approved])).toEqual([["bg-1", false]]);
});
