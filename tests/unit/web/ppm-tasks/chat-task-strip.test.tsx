/**
 * The task strip at the top of a chat that works on tasks: nothing for a chat that works on none,
 * "#N title" with its status (or wait), due date and snooze for one, the first in "what to do
 * first" order plus "+N" for several — and the list "+N" opens, whose rows open the quick view.
 * The strip reads only the tasks naming the chat as their working session (`?session=`).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { chatTaskStripView, chatTaskStripLabel, chatTasksQuery } = await import("../../../../src/web/lib/ppm-tasks/chat-task-strip-logic");
const { matchesQuery, listKey } = await import("../../../../src/web/lib/ppm-tasks/ppm-tasks-list-logic");
const { taskListPath } = await import("../../../../src/web/lib/ppm-tasks/ppm-tasks-client");
const { ChatTaskStrip } = await import("../../../../src/web/components/ppm-tasks/chat-strip/chat-task-strip");

const SID = "chat-1";
const mine = (over: Partial<TaskDto> = {}) => taskDto({ workingSessionId: SID, statusId: "ip", statusName: "In progress", baseGroup: "active", ...over });

describe("chatTaskStripView", () => {
  it("is null for a chat that works on no open task", () => {
    expect(chatTaskStripView([], SID)).toBeNull();
    expect(chatTaskStripView([mine({ baseGroup: "closed", closedAs: "done" }), taskDto({ workingSessionId: "other" })], SID)).toBeNull();
  });

  it("one task: it leads, no +N", () => {
    const t = mine({ title: "Fix login" });
    const v = chatTaskStripView([t], SID)!;
    expect(v.primary.id).toBe(t.id);
    expect(v.extra).toBe(0);
    expect(chatTaskStripLabel(v)).toBe(`This chat's task: #${t.number} Fix login, In progress`);
  });

  it("several: the most urgent leads, snoozed ones come last, +N counts the rest", () => {
    const later = mine({ urgency: "later", title: "Later" });
    const now = mine({ urgency: "now", title: "Now" });
    const snoozedNow = mine({ urgency: "now", title: "Snoozed", snoozed: true, snoozedUntil: "2099-01-01" });
    const v = chatTaskStripView([later, snoozedNow, now], SID)!;
    expect(v.all.map((t) => t.title)).toEqual(["Now", "Later", "Snoozed"]);
    expect(v.extra).toBe(2);
    expect(chatTaskStripLabel(v)).toContain("and 2 more");
  });

  it("the query asks for this chat's tasks across projects, snoozed ones too", () => {
    const q = chatTasksQuery(SID);
    expect(taskListPath(q)).toBe("/api/tasks?project=all&snoozed=1&session=chat-1");
    expect(listKey(q)).not.toBe(listKey({ ...q, session: "chat-2" }));
    expect(matchesQuery(mine(), q)).toBe(true);
    expect(matchesQuery(taskDto({ workingSessionId: "chat-2" }), q)).toBe(false);
  });
});

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let served: TaskDto[] = [];
let asked: string[] = [];

function serve(): void {
  installDom();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const data = url.includes("/api/tasks?") ? { tasks: served, projects: [] } : null;
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

afterEach(async () => { await view?.unmount(); view = null; asked = []; globalThis.fetch = realFetch; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const strip = () => document.querySelector<HTMLElement>("[data-chat-task-strip]");

describe("ChatTaskStrip", () => {
  it("renders nothing when the chat works on no task", async () => {
    serve();
    served = [];
    view = await mount(<ChatTaskStrip sessionId="chat-none" projectName="demo" />);
    await settle();
    expect(asked.some((u) => u.includes("session=chat-none"))).toBe(true);
    expect(strip()).toBeNull();
  });

  it("one task: code, title, status and due date; a press opens its quick view", async () => {
    serve();
    served = [mine({ id: "11111111-1111-4111-8111-111111111111", number: 12, title: "Fix login", dueDate: "2099-12-31", workingSessionId: "chat-one" })];
    view = await mount(<ChatTaskStrip sessionId="chat-one" projectName="demo" />);
    await settle();
    const s = strip()!;
    expect(s.getAttribute("data-chat-task-strip-count")).toBe("1");
    expect(s.textContent).toContain("#12");
    expect(s.textContent).toContain("Fix login");
    expect(s.querySelector("[data-chat-task-strip-status]")!.textContent).toBe("In progress");
    expect(s.querySelector("[data-due]")).not.toBeNull();
    expect(s.querySelector("[data-chat-task-strip-more]")).toBeNull();
    await act(async () => { s.querySelector<HTMLButtonElement>("[data-chat-task-strip-open]")!.click(); });
    await settle();
    expect(document.querySelector('[role=dialog][aria-label="Task #12 Fix login"]')).not.toBeNull();
  });

  it("a waiting task says on whom it waits instead of its status", async () => {
    serve();
    served = [mine({ number: 3, title: "Ship", workingSessionId: "chat-wait", baseGroup: "waiting", statusName: "Waiting", waitingOnMemberId: "me" })];
    view = await mount(<ChatTaskStrip sessionId="chat-wait" projectName="demo" />);
    await settle();
    expect(strip()!.querySelector("[data-task-waiting=me]")).not.toBeNull();
    expect(strip()!.querySelector("[data-chat-task-strip-status]")).toBeNull();
  });

  it("several tasks: the first leads with +N, which lists them all; a row opens that task", async () => {
    serve();
    served = [
      mine({ number: 1, title: "First", urgency: "now", workingSessionId: "chat-many" }),
      mine({ number: 2, title: "Second", urgency: "week", workingSessionId: "chat-many" }),
      mine({ number: 3, title: "Third", urgency: "later", workingSessionId: "chat-many" }),
    ];
    view = await mount(<ChatTaskStrip sessionId="chat-many" projectName="demo" />);
    await settle();
    const s = strip()!;
    expect(s.querySelector("[data-chat-task-strip-title]")!.textContent).toBe("First");
    const more = s.querySelector<HTMLButtonElement>("[data-chat-task-strip-more]")!;
    expect(more.textContent).toBe("+2");
    await act(async () => { more.click(); });
    await settle();
    const rows = [...document.querySelectorAll("[data-chat-task-strip-row]")];
    expect(rows.map((r) => r.querySelector("button")!.title)).toEqual(["Show #1 First", "Show #2 Second", "Show #3 Third"]);
    await act(async () => { rows[2]!.querySelector("button")!.click(); });
    // The list leaves after its 100ms exit animation.
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(document.querySelector("[data-chat-task-strip-list]")).toBeNull();
    expect(document.querySelector('[role=dialog][aria-label="Task #3 Third"]')).not.toBeNull();
  });
});
