/**
 * The manager chat's Tasks list shows a task's quick view instead of leaving for it: a row opens
 * a popover beside the list and the list stays, another row moves the popover to that task, a
 * field saves (a half-typed next step too, when the popover moves on), and Escape closes the
 * popover first and the list only on the second press. On a phone the list's own sheet turns
 * into the task's page, with a back button to the list.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto, TaskProjectSettings, TaskProjectSummary } from "../../../../src/shared/ppm-tasks-api.ts";

installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { ManagerTasksChip } = await import("../../../../src/web/components/ppm-tasks/chip/manager-tasks-chip");
const { ppmTasksStore } = await import("../../../../src/web/stores/ppm-tasks-store");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
const settle = async (ms = 0) => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

const SETTINGS: TaskProjectSettings = {
  project: { name: "alpha", projectKey: "k-demo", enabled: true, hasManager: true, open: 2, now: 1, enabledBy: "user", checkIntervalMin: 30 },
  statuses: [
    { id: "todo", projectKey: "k-demo", name: "To do", baseGroup: "not_started", closedAs: null, position: 0 },
    { id: "prog", projectKey: "k-demo", name: "In progress", baseGroup: "active", closedAs: null, position: 1 },
  ],
  members: [{ id: "m1", projectKey: "k-demo", name: "Minh Anh", jiraAccountId: null, githubLogin: null, slackUserId: null, position: 0, archivedAt: null }],
  fieldDefs: [],
};

let tasks: TaskDto[] = [];
let writes: Array<{ id: string; method: string; body: Record<string, unknown> }> = [];

function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    let data: unknown = [];
    const byId = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (path === "/api/tasks") data = { tasks, projects: [] };
    else if (path === "/api/tasks/link-states") data = { tasks: {} };
    else if (path === "/api/tasks/projects/alpha/settings") data = SETTINGS;
    else if (path.endsWith("/history")) data = [];
    else if (byId && method === "GET") data = { task: tasks.find((t) => t.id === byId[1]), children: [], linkStates: [] };
    else if (byId && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ id: byId[1]!, method, body });
      const i = tasks.findIndex((t) => t.id === byId[1]);
      const { revision: _r, ...patch } = body;
      tasks[i] = { ...tasks[i]!, ...patch, revision: tasks[i]!.revision + 1 } as TaskDto;
      data = { task: tasks[i], managerPrompt: false };
    }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const summary: Pick<TaskProjectSummary, "name" | "open" | "now"> = { name: "alpha", open: 2, now: 1 };

afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  writes = [];
  ppmTasksStore.setState({ lists: {}, details: {} } as never);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const escape = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await settle(); };
const peek = () => $("[data-task-peek-popover]");
const list = () => $("[data-footer-popover]");
const row = (id: string) => $(`[data-chip-task="${id}"] [data-chip-task-open]`);

async function openList(): Promise<void> {
  view = await mount(<ManagerTasksChip summary={summary} />);
  await click($("[data-manager-tasks-chip]"));
  await settle();
}

function seed(): [TaskDto, TaskDto] {
  const a = taskDto({ project: "alpha", title: "Fix the export", urgency: "now", workingSession: { kind: "start_chat" } });
  const b = taskDto({ project: "alpha", title: "Call the bank", urgency: "today" });
  tasks = [a, b];
  return [a, b];
}

describe("the Tasks list's quick view (desktop)", () => {
  it("opens beside the list, keeps the list, and moves to another task on another row", async () => {
    const [a, b] = seed();
    serve();
    await openList();
    await click(row(a.id));
    expect(peek()?.getAttribute("data-task-peek-popover")).toBe(a.id);
    expect(peek()?.getAttribute("role")).toBe("dialog");
    expect(list()).not.toBeNull();
    expect($(`[data-chip-task="${a.id}"]`)?.hasAttribute("data-chip-task-selected")).toBe(true);
    expect($("[data-task-peek-title]")?.textContent).toContain("Fix the export");

    await click(row(b.id));
    expect(document.querySelectorAll("[data-task-peek-popover]")).toHaveLength(1);
    expect(peek()?.getAttribute("data-task-peek-popover")).toBe(b.id);
    expect($("[data-task-peek-title]")?.textContent).toContain("Call the bank");
    expect(list()).not.toBeNull();

    // The row already shown hides it again.
    await click(row(b.id));
    expect(peek()).toBeNull();
    expect(list()).not.toBeNull();
  });

  it("saves a field on change, and a next step typed but not left when the quick view moves on", async () => {
    const [a, b] = seed();
    serve();
    await openList();
    await click(row(b.id));
    const status = $<HTMLSelectElement>("[data-task-peek] select[aria-label='Status']")!;
    await act(async () => { status.value = "prog"; status.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(writes).toContainEqual(expect.objectContaining({ id: b.id, body: expect.objectContaining({ statusId: "prog" }) }));

    const next = $<HTMLTextAreaElement>("[data-task-peek] textarea[aria-label='Next step']")!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(next, "Ask Acme for the file"); next.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(row(a.id));
    expect(peek()?.getAttribute("data-task-peek-popover")).toBe(a.id);
    expect(writes).toContainEqual(expect.objectContaining({ id: b.id, body: expect.objectContaining({ nextStep: "Ask Acme for the file" }) }));
    expect(tasks.find((t) => t.id === b.id)?.nextStep).toBe("Ask Acme for the file");
  });

  it("closes the quick view on the first Escape and the list on the second", async () => {
    const [a] = seed();
    serve();
    await openList();
    await click(row(a.id));
    expect(peek()).not.toBeNull();
    await escape();
    expect(peek()).toBeNull();
    expect(list()).not.toBeNull();
    await escape();
    await settle(30);
    expect(list()).toBeNull();
  });

  it("closes both on a press outside the list and the quick view, and neither on a press inside the quick view", async () => {
    const [a] = seed();
    serve();
    await openList();
    await click(row(a.id));
    await act(async () => { $("[data-task-peek-title]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await settle();
    expect(peek()).not.toBeNull();
    expect(list()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await settle(30);
    expect(peek()).toBeNull();
    expect(list()).toBeNull();
  });
});

describe("the Tasks list's quick view (phone)", () => {
  it("turns the list's sheet into the task's page, and back returns to the list", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const [a] = seed();
    serve();
    await openList();
    await click(row(a.id));
    expect(peek()).toBeNull();
    const page = $(`[data-task-peek="${a.id}"]`);
    expect(page?.getAttribute("data-task-peek-layout")).toBe("sheet");
    expect($("[data-manager-tasks-list]")).toBeNull();
    expect($("[data-task-peek-page]")?.getAttribute("data-task-peek-page")).toBe("full-screen");
    await click($("[data-task-peek-back]"));
    expect($(`[data-task-peek="${a.id}"]`)).toBeNull();
    expect($("[data-manager-tasks-list]")).not.toBeNull();
  });
});
