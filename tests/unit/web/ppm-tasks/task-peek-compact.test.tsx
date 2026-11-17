/**
 * The quick view's compact layout: the fields as chips (each still edits its field, an empty one
 * stays as a faint chip to set it), the next step folded to two lines and unfolded by a press,
 * and the task's links drawn as the task page draws them, folded into "+N" past four.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import { PEEK_LINK_LIMIT, addDaysYmd, peekChipTitle, peekDuePresets, peekLinks, peekMemberName } from "../../../../src/web/lib/ppm-tasks/task-peek-compact";
import { localYmd } from "../../../../src/web/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { LinkState, TaskLink, TaskPatch } from "../../../../src/shared/ppm-tasks.ts";
import type { TaskProjectSettings } from "../../../../src/shared/ppm-tasks-api.ts";

installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { TaskPeekFields } = await import("../../../../src/web/components/ppm-tasks/peek/task-peek-fields");
const { TaskPeekLinks } = await import("../../../../src/web/components/ppm-tasks/peek/task-peek-links");

describe("peekLinks", () => {
  const six = ["a", "b", "c", "d", "e", "f"];
  it("draws every link up to the limit", () => {
    expect(peekLinks(six.slice(0, PEEK_LINK_LIMIT), false)).toEqual({ shown: six.slice(0, 4), hidden: 0 });
    expect(peekLinks([], false)).toEqual({ shown: [], hidden: 0 });
  });
  it("past the limit, folds the rest into +N in the last place, never a +1 for a link that fits", () => {
    expect(peekLinks(six.slice(0, 5), false)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
    expect(peekLinks(six, false)).toEqual({ shown: ["a", "b", "c"], hidden: 3 });
  });
  it("draws them all once expanded", () => {
    expect(peekLinks(six, true)).toEqual({ shown: six, hidden: 0 });
  });
});

describe("chip words", () => {
  const people = [{ id: "me", name: "You" }, { id: "m1", name: "Minh Anh" }];
  it("names the member picked, nobody as null, and one not listed as such", () => {
    expect(peekMemberName("m1", people)).toBe("Minh Anh");
    expect(peekMemberName(null, people)).toBeNull();
    expect(peekMemberName("gone", people)).toBe("Unknown member");
    expect(peekMemberName("m1", [], "…")).toBe("…");
  });
  it("offers today, tomorrow and a week on as due dates, across a month and a year", () => {
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-02-28", 1)).toBe("2026-03-01");
    expect(peekDuePresets("2026-11-27")).toEqual([
      { label: "Today", ymd: "2026-11-27", hint: "Fri 27 Nov" },
      { label: "Tomorrow", ymd: "2026-11-28", hint: "Sat 28 Nov" },
      { label: "In a week", ymd: "2026-12-04", hint: "Fri 4 Dec" },
    ]);
  });
  it("says the field and its value, or how to set an empty one", () => {
    expect(peekChipTitle("Urgency", "Today")).toBe("Urgency: Today");
    expect(peekChipTitle("Due date", null)).toBe("Add due date");
  });
});

const SETTINGS: TaskProjectSettings = {
  project: { name: "demo", projectKey: "k-demo", enabled: true, hasManager: true, open: 1, now: 0, enabledBy: "user", checkIntervalMin: 30 },
  statuses: [
    { id: "todo", projectKey: "k-demo", name: "To do", baseGroup: "not_started", closedAs: null, position: 0 },
    { id: "prog", projectKey: "k-demo", name: "In progress", baseGroup: "active", closedAs: null, position: 1 },
  ],
  members: [{ id: "m1", projectKey: "k-demo", name: "Minh Anh", jiraAccountId: null, githubLogin: null, slackUserId: null, position: 0, archivedAt: null }],
  fieldDefs: [],
};

let view: Mounted | null = null;
afterEach(() => { view?.unmount(); view = null; });
const $ = <T extends Element = HTMLElement>(sel: string) => view!.container.querySelector<T>(sel);
const $$ = (sel: string) => [...view!.container.querySelectorAll(sel)];
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

/** Opens a chip's menu (Radix opens it on a primary-button pointerdown); answers its choices. */
async function openChip(field: string): Promise<HTMLElement[]> {
  const chip = $(`[data-task-peek-chip=${field}]`)!;
  await act(async () => { chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const menu = document.querySelector<HTMLElement>(`[data-task-peek-menu=${field}]`);
  if (!menu) throw new Error(`the ${field} menu did not open`);
  return [...menu.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitem]")];
}

async function pick(field: string, value: string) {
  const items = await openChip(field);
  await click(items.find((i) => i.getAttribute("data-task-peek-choice") === value) ?? null);
  await settle();
  expect(document.querySelector(`[data-task-peek-menu=${field}]`)).toBeNull();
}

describe("TaskPeekFields", () => {
  it("draws the six fields as chips, empty ones faint, each one's control still editing its field", async () => {
    const patches: TaskPatch[] = [];
    const statuses: string[] = [];
    const task = taskDto({ statusId: "todo", statusName: "To do", urgency: "today", importance: "must", assigneeMemberId: "me" });
    view = await mount(<TaskPeekFields task={task} settings={SETTINGS} onPatch={(p) => { patches.push(p); }} onStatus={(s) => statuses.push(s)} />);

    expect($$("[data-task-peek-chip]").map((c) => c.getAttribute("data-task-peek-chip"))).toEqual(["status", "urgency", "importance", "assignee", "waiting", "due"]);
    expect($$("[data-task-peek-chip][data-empty]").map((c) => c.getAttribute("data-task-peek-chip"))).toEqual(["waiting", "due"]);
    expect($("[data-task-peek-chip=status]")?.textContent).toContain("To do");
    expect($("[data-task-peek-chip=urgency]")?.getAttribute("title")).toBe("Urgency: Today");
    expect($("[data-task-peek-chip=assignee]")?.textContent).toContain("You");
    expect($("[data-task-peek-chip=waiting]")?.getAttribute("title")).toBe("Add waiting on");

    // A chip's menu offers the task page's choices, the current one marked: every status, every
    // urgency, Nobody / You / the project's members.
    const statusItems = await openChip("status");
    expect(statusItems.map((i) => i.getAttribute("data-task-peek-choice"))).toEqual(["todo", "prog"]);
    expect(statusItems.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await click(statusItems[1]!);
    await settle();
    expect((await openChip("waiting")).map((i) => i.getAttribute("data-task-peek-choice"))).toEqual(["", "me", "m1"]);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();

    await pick("urgency", "now");
    await pick("importance", "nice");
    await pick("assignee", "");
    await pick("waiting", "m1");
    // Picking the value already set writes nothing.
    await pick("urgency", "today");
    expect(statuses).toEqual(["prog"]);
    expect(patches).toEqual([{ urgency: "now" }, { importance: "nice" }, { assigneeMemberId: null }, { waitingOnMemberId: "m1" }]);
  });

  it("names a member chip and marks an urgency the due date raised", async () => {
    const task = taskDto({ waitingOnMemberId: "m1", urgency: "week", effectiveUrgency: "today", urgencyRaised: true, dueDate: "2026-11-20" });
    view = await mount(<TaskPeekFields task={task} settings={SETTINGS} onPatch={() => {}} onStatus={() => {}} />);
    expect($("[data-task-peek-chip=waiting]")?.textContent).toContain("Minh Anh");
    expect($("[data-task-peek-chip=urgency]")?.getAttribute("title")).toBe("Urgency: Today (raised from This week by the due date)");
    expect($("[data-task-peek-chip=urgency]")?.textContent).toContain("auto");
    expect($("[data-task-peek-chip=due]")?.hasAttribute("data-empty")).toBe(false);
    expect($<HTMLInputElement>("input[aria-label='Due date']")?.value).toBe("2026-11-20");
  });

  it("sets the due date from its menu: a date offered, one picked, or none", async () => {
    const patches: TaskPatch[] = [];
    view = await mount(<TaskPeekFields task={taskDto({ dueDate: "2026-11-20" })} settings={SETTINGS} onPatch={(p) => { patches.push(p); }} onStatus={() => {}} />);
    expect($("[data-task-peek-chip=due]")?.getAttribute("title")).toMatch(/^Due date: .+ \(2026-11-20\)$/);
    expect((await openChip("due")).map((i) => i.getAttribute("data-task-peek-choice"))).toEqual(["Today", "Tomorrow", "In a week", "pick", "none"]);
    await click(document.querySelector("[data-task-peek-menu=due] [data-task-peek-choice=Tomorrow]"));
    await settle();
    await pick("due", "none");
    // What the browser's picker fills in saves at once: the input takes nothing typed.
    const input = $<HTMLInputElement>("input[aria-label='Due date']")!;
    expect(input.tabIndex).toBe(-1);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "2026-12-01"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(patches).toEqual([{ dueDate: addDaysYmd(localYmd(), 1) }, { dueDate: null }, { dueDate: "2026-12-01" }]);
  });

  it("offers no 'No due date' for a task without one", async () => {
    view = await mount(<TaskPeekFields task={taskDto()} settings={SETTINGS} onPatch={() => {}} onStatus={() => {}} />);
    expect((await openChip("due")).map((i) => i.getAttribute("data-task-peek-choice"))).toEqual(["Today", "Tomorrow", "In a week", "pick"]);
  });

  it("keeps a next step whose save did not land, shows it folded, and sends it again when next left", async () => {
    const sent: Array<string | null> = [];
    let answer: unknown = null;
    view = await mount(<TaskPeekFields task={taskDto({ nextStep: "A" })} settings={SETTINGS} onPatch={(p) => { sent.push(p.nextStep ?? null); return Promise.resolve(answer); }} onStatus={() => {}} />);
    await click($("[data-task-peek-next-step]"));
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    let field = $<HTMLTextAreaElement>("textarea[aria-label='Next step']")!;
    await act(async () => { setValue.call(field, "B"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { field.blur(); });
    await settle();
    expect(sent).toEqual(["B"]);
    expect($("[data-task-peek-next-step-text]")?.textContent).toBe("B");
    // Unfolded again, it holds what was typed, not the stored "A"; leaving it sends that again.
    await click($("[data-task-peek-next-step]"));
    field = $<HTMLTextAreaElement>("textarea[aria-label='Next step']")!;
    expect(field.value).toBe("B");
    answer = { ok: true };
    await act(async () => { field.blur(); });
    await settle();
    expect(sent).toEqual(["B", "B"]);
  });

  it("shows a member not named yet while the project's members are being read", async () => {
    view = await mount(<TaskPeekFields task={taskDto({ assigneeMemberId: "m1" })} settings={null} onPatch={() => {}} onStatus={() => {}} />);
    expect($("[data-task-peek-chip=assignee]")?.getAttribute("title")).toBe("Assignee: …");
  });

  it("folds the next step to two lines, unfolds it into the field on a press, and folds it again once left, saved", async () => {
    const patches: TaskPatch[] = [];
    view = await mount(<TaskPeekFields task={taskDto({ nextStep: "Ask QA for a staging slot" })} settings={SETTINGS} onPatch={(p) => { patches.push(p); }} onStatus={() => {}} />);
    expect($("textarea[aria-label='Next step']")).toBeNull();
    const folded = $("[data-task-peek-next-step]")!;
    expect($("[data-task-peek-next-step-text]")?.className).toContain("line-clamp-2");
    expect(folded.textContent).toContain("Ask QA for a staging slot");

    await click(folded);
    const field = $<HTMLTextAreaElement>("textarea[aria-label='Next step']")!;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(field, "Ship it Friday"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { field.blur(); });
    await settle();
    expect(patches).toEqual([{ nextStep: "Ship it Friday" }]);
    expect($("textarea[aria-label='Next step']")).toBeNull();
    expect($("[data-task-peek-next-step]")?.textContent).toContain("Ship it Friday");
  });

  it("offers an empty next step as the place to add one", async () => {
    view = await mount(<TaskPeekFields task={taskDto()} settings={SETTINGS} onPatch={() => {}} onStatus={() => {}} />);
    expect($("[data-task-peek-next-step]")?.getAttribute("aria-label")).toBe("Add the next step");
  });
});

const LINKS: TaskLink[] = [
  { kind: "jira", ref: "NX-6318", label: null },
  { kind: "pr", ref: "acme/web#42", label: null },
  { kind: "session", ref: "sess-1", label: "Fix login" },
  { kind: "url", ref: "https://acme.slack.com/archives/C1/p1", label: null },
  { kind: "pr", ref: "acme/api#7", label: null },
  { kind: "jira", ref: "NX-6400", label: null },
];
const STATES: LinkState[] = [
  { kind: "jira", ref: "NX-6318", state: { status: "In Review", category: "indeterminate" }, error: null, checkedAt: 1, changedAt: 1 },
  { kind: "pr", ref: "acme/web#42", state: { state: "merged" }, error: null, checkedAt: 1, changedAt: 1 },
  { kind: "session", ref: "sess-1", state: { state: "running", title: "Fix login" }, error: null, checkedAt: 1, changedAt: 1 },
];

describe("TaskPeekLinks", () => {
  it("draws nothing for a task with no links", async () => {
    view = await mount(<TaskPeekLinks task={taskDto()} linkStates={[]} onOpenChat={() => {}} />);
    expect($("[data-task-peek-links]")).toBeNull();
  });

  it("shows the first links with their live state, +N for the rest, all of them on a press, and folds back", async () => {
    view = await mount(<TaskPeekLinks task={taskDto({ links: LINKS })} linkStates={STATES} jiraSite="https://acme.atlassian.net" onOpenChat={() => {}} />);
    expect($$("[data-link-kind]")).toHaveLength(3);
    expect($("[data-task-peek-links-more]")?.textContent).toBe("+3");
    expect($("[data-link-kind=jira]")?.textContent).toContain("In Review");
    expect($("[data-link-kind=pr]")?.textContent).toContain("merged");
    expect($("[data-link-kind=session]")?.textContent).toContain("running");
    expect($<HTMLAnchorElement>("[data-link-kind=jira]")?.href).toBe("https://acme.atlassian.net/browse/NX-6318");
    expect($<HTMLAnchorElement>("[data-link-kind=pr]")?.href).toBe("https://github.com/acme/web/pull/42");

    await click($("[data-task-peek-links-more]"));
    expect($$("[data-link-kind]")).toHaveLength(6);
    expect($("[data-task-peek-links-more]")).toBeNull();
    await click($("[data-task-peek-links-fewer]"));
    expect($$("[data-link-kind]")).toHaveLength(3);
  });

  it("opens a chat link inside PPM", async () => {
    const opened: string[] = [];
    view = await mount(<TaskPeekLinks task={taskDto({ links: LINKS.slice(0, 4) })} linkStates={STATES} onOpenChat={(sid) => opened.push(sid)} />);
    expect($("[data-task-peek-links-more]")).toBeNull();
    await click($("button[data-link-kind=session]"));
    expect(opened).toEqual(["sess-1"]);
  });
});
