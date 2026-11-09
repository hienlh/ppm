import { expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { backgroundShellRegistry } from "../../../src/services/background-shell-registry.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { collabApprovalBroker } from "../../../src/services/session-collab/collab-approval-broker.ts";
import type { SessionCollabApprovalInput } from "../../../src/shared/session-collab.ts";

const createSessionCard: SessionCollabApprovalInput = { kind: "create", title: "Docs", providerId: "claude", model: null, task: "Write the docs", depth: 1 };

const ask = (requestId: string, question: string) => ({
  type: "approval_request", requestId, tool: "AskUserQuestion",
  input: { questions: [{ question, header: "Q", options: [{ label: "Yes" }, { label: "No" }] }] },
});

/**
 * A turn that asks two questions at once — parallel tool calls in one message — and stays
 * blocked on them, the way Claude's canUseTool waits, until the test is over.
 */
async function twoQuestionsAtOnce(after: unknown[] = []) {
  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "asking" } as any;
    yield ask("first", "Which bar?") as any;
    yield ask("second", "Which button?") as any;
    await gate;
    for (const ev of after) yield ev as any;
    if (after.length > 0) await closed;
  });
  const resolved = spyOn(chatService, "resolveApproval").mockImplementation(() => {});
  const sockets: any[] = [];
  const connect = () => {
    const messages: any[] = [];
    const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as any);
    return { socket, messages, of: (type: string) => messages.filter((m) => m.type === type) };
  };
  const say = (socket: unknown, msg: unknown) => chatWebSocket.message(socket as any, JSON.stringify(msg));
  const phone = connect();
  await say(phone.socket, { type: "message", content: "plan the feature" });
  for (let i = 0; i < 100 && phone.of("approval_request").length === 0; i++) await Bun.sleep(5);
  const done = () => {
    release();
    close();
    send.mockRestore();
    resolved.mockRestore();
    for (const socket of sockets) chatWebSocket.close(socket);
  };
  return { session, phone, connect, say, resolved, done, release };
}

const shownIds = (device: { of: (type: string) => any[] }) => device.of("approval_request").map((m) => m.requestId);

it("shows the second question only once the first is answered, so neither card is lost", async () => {
  const { phone, connect, say, resolved, done } = await twoQuestionsAtOnce();
  try {
    expect(shownIds(phone)).toEqual(["first"]);
    const late = connect();
    expect(late.of("session_state")[0].pendingApproval.requestId).toBe("first");
    expect(late.of("turn_events")[0].events.filter((e: any) => e.type === "approval_request").map((e: any) => e.requestId)).toEqual(["first"]);

    await say(phone.socket, { type: "approval_response", requestId: "first", approved: true, data: { "Which bar?": "Yes" } });
    expect(shownIds(phone)).toEqual(["first", "second"]);
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("second");

    await say(phone.socket, { type: "approval_response", requestId: "second", approved: true, data: { "Which button?": "No" } });
    expect(resolved.mock.calls.map((call) => call[2])).toEqual(["first", "second"]);
    expect(connect().of("session_state")[0].pendingApproval).toBeNull();
  } finally {
    done();
  }
});

it("skips every question still waiting when the user sends a message instead", async () => {
  const { phone, say, resolved, done } = await twoQuestionsAtOnce();
  try {
    await say(phone.socket, { type: "message", content: "never mind, do this instead" });
    expect(resolved.mock.calls.map((call) => [call[2], call[3]])).toEqual([["first", false], ["second", false]]);
    expect(phone.of("approval_resolved").map((m) => m.requestId)).toEqual(["first", "second"]);
    expect(shownIds(phone)).toEqual(["first"]);
  } finally {
    done();
  }
});

it("an answer to a question still in line does not hide the one on screen", async () => {
  const { phone, connect, say, done } = await twoQuestionsAtOnce();
  try {
    await say(phone.socket, { type: "approval_response", requestId: "second", approved: false });
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("first");

    await say(phone.socket, { type: "approval_response", requestId: "first", approved: true });
    expect(shownIds(phone)).toEqual(["first"]);
    expect(connect().of("session_state")[0].pendingApproval).toBeNull();
  } finally {
    done();
  }
});

it("stopping a background command leaves the question on screen", async () => {
  const { session, phone, connect, say, done } = await twoQuestionsAtOnce();
  const mock = providerRegistry.get("mock") as any;
  mock.pushMessage = () => {};
  const pushed = spyOn(chatService, "pushMessage").mockImplementation(async () => {});
  try {
    backgroundShellRegistry.register(session.id, { shellId: "sh1", command: "bun dev", outputPath: "/tmp/sh1.output", toolUseId: "tu-sh1" });
    await say(phone.socket, { type: "kill_background_shell", shellId: "sh1" });
    expect(pushed).toHaveBeenCalled();
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("first");
    expect(shownIds(phone)).toEqual(["first"]);
  } finally {
    pushed.mockRestore();
    delete mock.pushMessage;
    done();
  }
});

it("a session tool's card waits behind both questions, then comes back and settles when answered", async () => {
  const { session, phone, connect, say, done } = await twoQuestionsAtOnce();
  try {
    // "first" holds the slot and "second" waits in line; the card waits in its broker.
    const outcome = collabApprovalBroker.request(session.id, createSessionCard);
    const card = collabApprovalBroker.pendingEvent(session.id)!;
    expect(shownIds(phone)).toEqual(["first"]);

    await say(phone.socket, { type: "approval_response", requestId: "first", approved: true });
    expect(shownIds(phone)).toEqual(["first", "second"]);
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("second");

    await say(phone.socket, { type: "approval_response", requestId: "second", approved: true });
    expect(shownIds(phone)).toEqual(["first", "second", card.requestId]);
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe(card.requestId);

    expect(collabApprovalBroker.answer(card.requestId, { answer: "allow_once" })).toEqual({ ok: true, answer: "allow_once" });
    expect(await outcome).toEqual({ allowed: true, answer: "allow_once" });
    expect(phone.of("approval_resolved").map((m) => m.requestId)).toContain(card.requestId);
    expect(connect().of("session_state")[0].pendingApproval).toBeNull();
  } finally {
    done();
  }
});

it("a message typed instead cancels a waiting session tool's card along with every question", async () => {
  const { session, phone, connect, say, resolved, done } = await twoQuestionsAtOnce();
  try {
    const outcome = collabApprovalBroker.request(session.id, createSessionCard);
    await say(phone.socket, { type: "message", content: "never mind, do this instead" });
    expect(await outcome).toMatchObject({ allowed: false, reason: "cancelled" });
    expect(resolved.mock.calls.map((call) => [call[2], call[3]])).toEqual([["first", false], ["second", false]]);
    expect(collabApprovalBroker.pendingEvent(session.id)).toBeNull();
    expect(connect().of("session_state")[0].pendingApproval).toBeNull();
  } finally {
    done();
  }
});

it("a provider request takes the slot from a session tool's card, which comes back once it is answered", async () => {
  const session = await chatService.createSession("mock", {});
  let askNow!: () => void;
  const asking = new Promise<void>((resolve) => { askNow = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await asking;
    yield ask("provider-q", "Which bar?") as any;
    await gate;
  });
  const resolvedSpy = spyOn(chatService, "resolveApproval").mockImplementation(() => {});
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  const shown = () => messages.filter((m) => m.type === "approval_request").map((m) => m.requestId);
  try {
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "go" }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);

    const outcome = collabApprovalBroker.request(session.id, createSessionCard);
    const card = collabApprovalBroker.pendingEvent(session.id)!;
    expect(shown()).toEqual([card.requestId]);

    askNow();
    for (let i = 0; i < 100 && !shown().includes("provider-q"); i++) await Bun.sleep(5);
    expect(shown()).toEqual([card.requestId, "provider-q"]);

    await chatWebSocket.message(socket as any, JSON.stringify({ type: "approval_response", requestId: "provider-q", approved: true }));
    expect(shown()).toEqual([card.requestId, "provider-q", card.requestId]);

    collabApprovalBroker.answer(card.requestId, { answer: "deny" });
    expect(await outcome).toMatchObject({ allowed: false, reason: "denied" });
  } finally {
    release();
    askNow();
    send.mockRestore();
    resolvedSpy.mockRestore();
    chatWebSocket.close(socket as any);
  }
});

it("keeps both questions answerable through the turn's `done`, the second still in line behind the first", async () => {
  // A request is not tied to the turn it arrived in: a background agent asks whenever it gets
  // there and keeps waiting after the foreground turn ends, so a `done` takes no card away.
  const { phone, connect, say, resolved, release, done } = await twoQuestionsAtOnce([{ type: "done" }]);
  try {
    release();
    for (let i = 0; i < 100 && !phone.messages.some((m) => m.type === "done"); i++) await Bun.sleep(5);
    expect(resolved.mock.calls).toEqual([]);
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("first");

    await say(phone.socket, { type: "approval_response", requestId: "first", approved: true });
    expect(shownIds(phone)).toEqual(["first", "second"]);
    expect(connect().of("session_state")[0].pendingApproval.requestId).toBe("second");
  } finally {
    done();
  }
});
