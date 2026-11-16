/**
 * A Decision choice goes to the server's `decide` and nowhere else: the server sends it to the
 * working chat, so the page never puts text in a chat itself (`sendToChat`). When nobody can take
 * the choice the page offers Start chat; when the choice was recorded but not sent, Send again,
 * which decides again from the task as the server left it.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { toast } = await import("sonner");
const { TaskDecisionCard } = await import("../../../../src/web/components/ppm-tasks/task-decision-card");
const { useTaskWrite, decisionDeliveredMessage } = await import("../../../../src/web/components/ppm-tasks/use-task-write");
const { SEND_TO_CHAT_EVENT } = await import("../../../../src/web/lib/send-to-chat");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];
let sentToChat = 0;
const onSend = () => { sentToChat++; };

afterEach(async () => {
  await view?.unmount();
  view = null;
  requests = [];
  sentToChat = 0;
  globalThis.fetch = realFetch;
  window.removeEventListener(SEND_TO_CHAT_EVENT, onSend);
  toast.dismiss();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const decisionTask = (over: Partial<TaskDto> = {}) => taskDto({
  type: "decision",
  decision: { question: "Pension for November?", options: [{ id: "a", label: "As in October" }, { id: "b", label: "Full pay" }], chosen: null },
  workingSession: { kind: "manager", label: "Manager", session: { sessionId: "m1", state: "idle", title: "demo manager" } },
  ...over,
});

/** The server answers `decide` with `answer` (status 200) or an error body. */
function serve(answer: (body: { optionId: string; revision: number }) => { status: number; json: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: String(input), method: init?.method ?? "GET", body });
    const r = String(input).endsWith("/decide") ? answer(body) : { status: 200, json: { ok: true, data: [] } };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function Harness({ task }: { task: TaskDto }) {
  const write = useTaskWrite();
  return <TaskDecisionCard task={task} onChoose={(id) => void write.decide(task, id)} onEditOptions={() => {}} />;
}

const toasts = () => toast.getHistory() as Array<{ title?: unknown; type?: string; action?: { label: string; onClick(): void } }>;

describe("TaskDecisionCard", () => {
  it("calls decide with the option, never sendToChat, and says where the choice went", async () => {
    const task = decisionTask();
    serve((b) => ({ status: 200, json: { ok: true, data: { task: { ...task, revision: 2 }, managerPrompt: false, delivered: "started", sessionId: "m1" } } }));
    window.addEventListener(SEND_TO_CHAT_EVENT, onSend);
    view = await mount(<Harness task={task} />);
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Choose B")!);
    await settle();
    expect(requests.filter((r) => r.method !== "GET")).toEqual([{ url: `/api/tasks/${task.id}/decide`, method: "POST", body: { optionId: "b", revision: 1 } }]);
    expect(sentToChat).toBe(0);
    expect(toasts().some((t) => t.title === "Choice sent to the manager chat: it started working on it")).toBe(true);
  });

  it("offers Start chat when no chat can take the choice", async () => {
    serve(() => ({ status: 409, json: { ok: false, code: "no_session", error: "No chat works on this task" } }));
    view = await mount(<Harness task={decisionTask({ workingSession: { kind: "start_chat" } })} />);
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Choose A")!);
    await settle();
    const t = toasts().find((x) => x.action?.label === "Start chat");
    expect(t).toBeDefined();
    expect(sentToChat).toBe(0);
  });

  it("offers Send again when the choice was recorded but not sent, deciding from the new revision", async () => {
    const task = decisionTask();
    let calls = 0;
    serve((b) => {
      calls++;
      return { status: 200, json: { ok: true, data: { task: { ...task, revision: b.revision + 1 }, managerPrompt: false, delivered: null, sessionId: "m1", deliveryError: "the chat is gone" } } };
    });
    view = await mount(<Harness task={task} />);
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Choose A")!);
    await settle();
    const again = toasts().find((x) => x.action?.label === "Send again");
    expect(again).toBeDefined();
    expect(String(again!.title)).toContain("the chat is gone");
    await act(async () => { again!.action!.onClick(); });
    await settle();
    expect(calls).toBe(2);
    expect(requests.filter((r) => r.url.endsWith("/decide")).map((r) => (r.body as { revision: number }).revision)).toEqual([1, 2]);
  });

  it("shows the chosen option and who chose it", async () => {
    const task = decisionTask({ decision: { question: null, options: [{ id: "a", label: "One" }, { id: "b", label: "Two" }], chosen: { optionId: "a", at: 1, by: "You" } } });
    view = await mount(<TaskDecisionCard task={task} onChoose={() => {}} onEditOptions={() => {}} />);
    expect(document.body.textContent).toContain("Chosen by You");
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toContain("Choose B");
  });
});

describe("decisionDeliveredMessage", () => {
  it("names a handed-off chat by its title and says it was queued", () => {
    const task = taskDto({ workingSession: { kind: "session", session: { sessionId: "c", state: "running", title: "Fix PSR" } } });
    expect(decisionDeliveredMessage({ task, delivered: "queued" })).toBe('Choice sent to "Fix PSR": queued behind its current turn or a card waiting on you');
  });
});
