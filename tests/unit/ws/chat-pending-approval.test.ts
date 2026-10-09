/**
 * One approval card per chat session, shared by the provider and the PPM Assistant's endpoint:
 * neither overwrites the other, they queue and are shown in turn, a message typed instead of an
 * answer ends both (the endpoint's with "not run"), a reconnecting device is shown the card that
 * is still waiting, and an answer to a card nothing waits on any more is refused as no longer
 * valid instead of looking as if it ran.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { assistantApprovalBroker, type ApprovalAsk } from "../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { APPROVAL_NO_LONGER_VALID_MESSAGE } from "../../../src/shared/assistant-approval.ts";
import { setSessionAssistant, setSessionMetadata } from "../../../src/services/db.service.ts";

const ASK: ApprovalAsk = {
  tool: "db_query",
  input: { connection: "main", sql: "DELETE FROM t WHERE id = 1" },
  summary: { headline: "Run 1 SQL statement that may change data on \"main\"", facts: [{ label: "Connection", value: "main (sqlite)" }] },
};

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5); };

/** A session whose provider streams `events`, then holds its turn open until released. */
async function session(events: object[] = [], before?: Promise<void>) {
  const s = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    if (before) await before;
    for (const e of events) yield e as any;
    await gate;
  });
  const resolved = spyOn(chatService, "resolveApproval").mockImplementation(() => {});
  const sockets: any[] = [];
  const connect = () => {
    const messages: any[] = [];
    const socket = { data: { sessionId: s.id }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages, of: (type: string) => messages.filter((m) => m.type === type) };
  };
  const say = (socket: unknown, msg: object) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  cleanups.push(() => {
    release();
    send.mockRestore();
    resolved.mockRestore();
    for (const sock of sockets) chatWebSocket.close(sock);
  });
  return { id: s.id, connect, say, resolved };
}

const PROVIDER_CARD = { type: "approval_request", requestId: "prov-1", tool: "Bash", input: { command: "rm -rf build" } };

it("queues the endpoint's card behind the provider's, then shows it once that one is answered", async () => {
  const s = await session([PROVIDER_CARD]);
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "clean up" });
  await until(() => phone.of("approval_request").length === 1);

  const verdict = assistantApprovalBroker.request(s.id, ASK);
  // Not overwritten: the provider's card is still the one shown.
  expect(phone.of("approval_request")).toHaveLength(1);
  expect(phone.of("approval_request")[0].requestId).toBe("prov-1");

  await s.say(phone.socket, { type: "approval_response", requestId: "prov-1", approved: true });
  expect(s.resolved).toHaveBeenCalledWith("mock", s.id, "prov-1", true, undefined, { origin: "ws" });
  const resolvedThenShown = phone.messages.filter((m) => m.type === "approval_resolved" || m.type === "approval_request").map((m) => `${m.type}:${m.requestId}`);
  const endpointCard = phone.of("approval_request")[1];
  expect(endpointCard).toMatchObject({ origin: "endpoint", tool: "db_query", summary: ASK.summary });
  expect(resolvedThenShown.slice(-2)).toEqual(["approval_resolved:prov-1", `approval_request:${endpointCard.requestId}`]);

  await s.say(phone.socket, { type: "approval_response", requestId: endpointCard.requestId, approved: true });
  expect(await verdict).toEqual({ verdict: "approved" });
  expect(phone.of("approval_resolved").at(-1)).toMatchObject({ requestId: endpointCard.requestId, approved: true });
});

it("gives a card queued behind an unanswered one its whole answer window once it is shown", async () => {
  const prev = process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS;
  process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS = "150";
  cleanups.push(() => { if (prev === undefined) delete process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS; else process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS = prev; });
  const s = await session([PROVIDER_CARD]);
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "clean up" });
  await until(() => phone.of("approval_request").length === 1);

  let settled = false;
  const verdict = assistantApprovalBroker.request(s.id, ASK).then((v) => { settled = true; return v; });
  // The user takes longer over the provider's card than the endpoint card's whole window.
  await Bun.sleep(300);
  expect(settled).toBe(false);
  await s.say(phone.socket, { type: "approval_response", requestId: "prov-1", approved: true });
  const endpointCard = phone.of("approval_request")[1];
  expect(endpointCard.origin).toBe("endpoint");
  await s.say(phone.socket, { type: "approval_response", requestId: endpointCard.requestId, approved: true });
  expect(await verdict).toEqual({ verdict: "approved" });
});

it("queues a provider's card behind the endpoint's instead of replacing it", async () => {
  let push!: () => void;
  const later = new Promise<void>((resolve) => { push = resolve; });
  const s = await session([PROVIDER_CARD], later);
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("text").length > 0);

  const verdict = assistantApprovalBroker.request(s.id, ASK);
  const endpointCard = phone.of("approval_request")[0];
  expect(endpointCard.origin).toBe("endpoint");
  push();
  await Bun.sleep(30);
  expect(phone.of("approval_request")).toHaveLength(1);

  await s.say(phone.socket, { type: "approval_response", requestId: endpointCard.requestId, approved: false });
  expect((await verdict).verdict).toBe("denied");
  await until(() => phone.of("approval_request").length === 2);
  expect(phone.of("approval_request")[1].requestId).toBe("prov-1");
});

it("ends the endpoint's request with 'not run' when the user types a message instead", async () => {
  const s = await session();
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("text").length > 0);
  const verdict = assistantApprovalBroker.request(s.id, ASK);
  const card = phone.of("approval_request")[0];

  await s.say(phone.socket, { type: "message", content: "never mind, do something else" });
  expect(await verdict).toEqual({ verdict: "withdrawn", reason: "The user sent another message instead of answering; not run." });
  expect(phone.of("approval_resolved").at(-1)).toMatchObject({ requestId: card.requestId, approved: false });
  expect(assistantApprovalBroker.pendingCount()).toBe(0);
});

it("withdraws the endpoint's card when the user stops the turn", async () => {
  const s = await session();
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("text").length > 0);
  const abort = spyOn(chatService, "abortQuery").mockImplementation(() => {});
  cleanups.push(() => abort.mockRestore());
  const verdict = assistantApprovalBroker.request(s.id, ASK);
  await s.say(phone.socket, { type: "cancel" });
  expect((await verdict).verdict).toBe("withdrawn");
  expect(phone.of("approval_resolved")).toHaveLength(1);
});

it("shows a reconnecting device the card still waiting, and drops it when it goes", async () => {
  const s = await session();
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("text").length > 0);
  const verdict = assistantApprovalBroker.request(s.id, ASK);
  const card = phone.of("approval_request")[0];

  const laptop = s.connect();
  const greeting = laptop.of("session_state")[0];
  expect(greeting.pendingApproval).toMatchObject({ requestId: card.requestId, origin: "endpoint", summary: ASK.summary });
  await s.say(laptop.socket, { type: "ready" });
  expect(laptop.of("session_state").at(-1).pendingApproval.requestId).toBe(card.requestId);

  // First answer wins, from whichever device; the other device's card goes too.
  await s.say(laptop.socket, { type: "approval_response", requestId: card.requestId, approved: true });
  expect((await verdict).verdict).toBe("approved");
  expect(phone.of("approval_resolved").at(-1)).toMatchObject({ requestId: card.requestId, approved: true });
  await s.say(phone.socket, { type: "approval_response", requestId: card.requestId, approved: false });
  expect(phone.of("approval_stale")).toEqual([{ type: "approval_stale", requestId: card.requestId, message: APPROVAL_NO_LONGER_VALID_MESSAGE }]);
  await s.say(phone.socket, { type: "ready" });
  expect(phone.of("session_state").at(-1).pendingApproval).toBeNull();
});

it("refuses an answer to a card nothing waits on, without resolving anything", async () => {
  const s = await session();
  const phone = s.connect();
  const other = s.connect();
  await s.say(phone.socket, { type: "approval_response", requestId: "from-before-the-restart", approved: true });
  expect(phone.of("approval_stale")).toHaveLength(1);
  expect(phone.of("approval_stale")[0].message).toContain("no longer valid");
  expect(phone.of("approval_resolved")).toHaveLength(0);
  expect(other.of("approval_resolved")).toHaveLength(0);
  expect(s.resolved).not.toHaveBeenCalled();
});

it("takes the card away on every device when nobody answers in time", async () => {
  const s = await session();
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("text").length > 0);
  const prev = process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS;
  process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS = "150";
  cleanups.push(() => { if (prev === undefined) delete process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS; else process.env.PPM_ASSISTANT_APPROVAL_TIMEOUT_MS = prev; });
  const verdict = await assistantApprovalBroker.request(s.id, ASK);
  expect(verdict.verdict).toBe("timeout");
  expect(phone.of("approval_resolved")).toHaveLength(1);
  await s.say(phone.socket, { type: "ready" });
  expect(phone.of("session_state").at(-1).pendingApproval).toBeNull();
});

it("never takes a provider's word that its card is the endpoint's", async () => {
  const s = await session([{ ...PROVIDER_CARD, origin: "endpoint", summary: { headline: "Totally harmless", facts: [] } }]);
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "go" });
  await until(() => phone.of("approval_request").length === 1);
  const card = phone.of("approval_request")[0];
  expect(card.origin).toBeUndefined();
  expect(card.summary).toBeUndefined();
});

it("in an Assistant session, shows the providers' own cards (Claude and Codex alike) in turn with the endpoint's", async () => {
  const claudeCard = { type: "approval_request", requestId: "claude-webfetch", tool: "WebFetch", input: { url: "https://example.com" } };
  const codexCard = { type: "approval_request", requestId: "codex-patch", tool: "apply_patch", input: { changes: { "a.txt": { add: "x" } } } };
  let push!: () => void;
  const later = new Promise<void>((resolve) => { push = resolve; });
  const s = await session([claudeCard, codexCard], later);
  setSessionMetadata(s.id, "__assistant__", "/somewhere");
  setSessionAssistant(s.id);
  const phone = s.connect();
  await s.say(phone.socket, { type: "message", content: "look this up and fix it" });
  await until(() => phone.of("text").length > 0);
  const verdict = assistantApprovalBroker.request(s.id, ASK);
  push();
  await Bun.sleep(30);
  const shown = () => phone.of("approval_request").map((m) => m.requestId);
  expect(shown()).toHaveLength(1);

  const endpointId = shown()[0];
  await s.say(phone.socket, { type: "approval_response", requestId: endpointId, approved: false });
  expect((await verdict).verdict).toBe("denied");
  expect(shown()).toEqual([endpointId, "claude-webfetch"]);
  await s.say(phone.socket, { type: "approval_response", requestId: "claude-webfetch", approved: true });
  expect(shown()).toEqual([endpointId, "claude-webfetch", "codex-patch"]);
  await s.say(phone.socket, { type: "approval_response", requestId: "codex-patch", approved: false });
  expect(s.resolved.mock.calls.map((c) => [c[2], c[3]])).toEqual([["claude-webfetch", true], ["codex-patch", false]]);
});
