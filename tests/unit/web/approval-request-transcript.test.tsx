/**
 * An approval request is not a tool card of its own. While it waits, the approval card stands
 * for it; once answered, the tool call's own card shows how it ended. Drawing the request as a
 * second card showed every approved or denied call twice, the extra one green even after a
 * denial — and only while live, since history never holds the request. A question is the one
 * request that is its own card, and a declined question reads as declined.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { InterleavedEvents } = await import("../../../src/web/components/chat/message-events");
const { approvalDrawsAsCard } = await import("../../../src/web/lib/approval-request");

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const FETCH_USE = { type: "tool_use", tool: "WebFetch", toolUseId: "tu-1", input: { url: "https://example.com", prompt: "p" } };
const FETCH_REQUEST = { type: "approval_request", requestId: "req-1", tool: "WebFetch", input: { url: "https://example.com", prompt: "p" } };
const FETCH_DENIED = { type: "tool_result", toolUseId: "tu-1", output: "User denied tool execution", isError: true };
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
  function Transcript() {
    const chat = useChat("approval-session", "claude", "approval-test");
    return <pre>{JSON.stringify(chat.messages)}</pre>;
  }
  view = await mount(<Transcript />);
  const emit = (data: unknown) => act(async () => {
    receive(new MessageEvent("message", { data: JSON.stringify(data) }));
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  const events = () => {
    const messages = JSON.parse(view!.container.textContent!) as Array<{ events?: Array<Record<string, unknown>> }>;
    return messages.at(-1)?.events ?? [];
  };
  return { emit, events };
}

function statusIcons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-icon='XCircle'], [data-icon='CheckCircle2'], [data-icon='Loader2']")]
    .map((el) => el.getAttribute("data-icon")!);
}

it("keeps only a question's request in the live transcript", async () => {
  const { emit, events } = await liveChat();
  await emit({ type: "session_state", sessionId: "approval-session", phase: "streaming" });
  await emit(FETCH_USE);
  await emit(FETCH_REQUEST);
  await emit({ type: "approval_resolved", requestId: "req-1", approved: false });
  await emit(FETCH_DENIED);
  expect(events().map((e) => e.type)).toEqual(["tool_use", "tool_result"]);

  await emit(QUESTION);
  await emit({ type: "approval_resolved", requestId: "req-q", approved: false });
  const question = events().find((e) => e.type === "approval_request")!;
  expect(question.requestId).toBe("req-q");
  expect(question.approved).toBe(false);
});

it("records a question's answers with its approval", async () => {
  const { emit, events } = await liveChat();
  await emit({ type: "session_state", sessionId: "approval-session", phase: "streaming" });
  await emit(QUESTION);
  await emit({ type: "approval_resolved", requestId: "req-q", approved: true, answers: { "Which one?": "B" } });
  const question = events().find((e) => e.type === "approval_request") as any;
  expect(question.approved).toBe(true);
  expect(question.input.answers).toEqual({ "Which one?": "B" });
});

it("draws a denied call once, as denied, live exactly as history draws it", async () => {
  // A replayed buffer still carries the request, stamped with the answer the server recorded.
  const live = await mount(<InterleavedEvents events={[FETCH_USE, { ...FETCH_REQUEST, approved: false }, FETCH_DENIED] as any} isStreaming={false} />);
  const liveIcons = statusIcons(live.container);
  const liveText = live.container.textContent;
  await live.unmount();
  const history = await mount(<InterleavedEvents events={[FETCH_USE, FETCH_DENIED] as any} isStreaming={false} />);
  try {
    expect(liveIcons).toEqual(["XCircle"]);
    expect(statusIcons(history.container)).toEqual(liveIcons);
    expect(history.container.textContent).toBe(liveText);
  } finally {
    await history.unmount();
  }
});

it("shows a declined question as declined and an answered one as done", async () => {
  const declined = await mount(<InterleavedEvents events={[{ ...QUESTION, approved: false }] as any} isStreaming={false} />);
  expect(statusIcons(declined.container)).toEqual(["XCircle"]);
  await declined.unmount();
  const answered = await mount(<InterleavedEvents events={[{ ...QUESTION, approved: true }] as any} isStreaming />);
  try {
    expect(statusIcons(answered.container)).toEqual(["CheckCircle2"]);
  } finally {
    await answered.unmount();
  }
});

it("names a question as the only request with a card of its own", () => {
  expect(approvalDrawsAsCard(QUESTION)).toBe(true);
  expect(approvalDrawsAsCard(FETCH_REQUEST)).toBe(false);
  expect(approvalDrawsAsCard({ type: "tool_use", tool: "AskUserQuestion" })).toBe(false);
});
