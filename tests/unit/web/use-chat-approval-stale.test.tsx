/**
 * A device draws its own answer on a question card at once, before the server confirms it. When
 * the server says the request was no longer waiting (`approval_stale`: answered elsewhere, ended
 * or from before a restart), nothing ran, so the card must not keep reading as answered — while
 * an answer the server did confirm, from any device, stays.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { approvalQuestions } = await import("../../../src/web/lib/approval-request");

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const QUESTION = {
  type: "approval_request", requestId: "req-q", tool: "AskUserQuestion",
  input: { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] },
};

async function liveChat() {
  let receive!: (event: MessageEvent) => void;
  spies.push(
    spyOn(api, "get").mockImplementation((path: string) => Promise.resolve(path === "/api/teams" ? [] : { messages: [] }) as any),
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => {}; }),
  );
  let chat!: ReturnType<typeof useChat>;
  function Transcript() {
    chat = useChat("stale-session", "claude", "stale-test");
    return <pre>{JSON.stringify(chat.messages)}</pre>;
  }
  view = await mount(<Transcript />);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const emit = (data: unknown) => act(async () => {
    receive(new MessageEvent("message", { data: JSON.stringify(data) }));
    await settle();
  });
  const answer = (approved: boolean, answersById?: Record<string, unknown>) => act(async () => {
    chat.respondToApproval("req-q", approved, answersById as never);
    await settle();
  });
  const question = () => {
    const messages = JSON.parse(view!.container.textContent!) as Array<{ events?: Array<Record<string, any>> }>;
    return messages.at(-1)?.events?.find((e) => e.type === "approval_request");
  };
  await emit({ type: "session_state", sessionId: "stale-session", phase: "streaming" });
  await emit(QUESTION);
  return { emit, answer, question, pending: () => chat.pendingApproval };
}

it("takes back this device's answer when the server says the request was no longer waiting", async () => {
  const c = await liveChat();
  const questionId = approvalQuestions(c.pending()!)[0]!.id;
  await c.answer(true, { [questionId]: ["B"] });
  expect(c.question()!.approved).toBe(true);
  expect(c.question()!.input.answers).toBeDefined();

  await c.emit({ type: "approval_stale", requestId: "req-q", message: "This approval request is no longer valid. Nothing was run." });
  expect(c.question()!.approved).toBe(false);
  expect(c.question()!.input.answers).toBeUndefined();
  expect(c.pending()).toBeNull();
});

it("keeps the answer the server confirmed, even when this device's own answer then comes back stale", async () => {
  const c = await liveChat();
  await c.answer(true);
  // Another device's answer reached the server first; its resolution is what happened.
  await c.emit({ type: "approval_resolved", requestId: "req-q", approved: true, answers: { "Which one?": "A" } });
  await c.emit({ type: "approval_stale", requestId: "req-q", message: "no longer valid" });
  expect(c.question()!.approved).toBe(true);
  expect(c.question()!.input.answers).toEqual({ "Which one?": "A" });
});
