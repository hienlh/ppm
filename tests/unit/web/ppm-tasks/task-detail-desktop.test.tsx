/**
 * A task's page shows every field of the brief: title, status, urgency with why the due date
 * raised it, importance, due, people, notes, result, links, tags, declared fields typed and
 * undeclared ones raw; and in its history, Undo only on AI changes that can still be undone, the
 * undone ones struck through, and "while you were away" on unattended rows.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskHistoryItem, TaskProjectSettings } from "../../../../src/shared/ppm-tasks-api.ts";

installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { TaskDetailDesktop } = await import("../../../../src/web/components/ppm-tasks/task-detail-desktop");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; globalThis.fetch = realFetch; });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const NOW = Date.now();
const actor = (kind: "user" | "manager" | "assistant", label: string) => ({ kind, label });
const row = (id: number, over: Partial<TaskHistoryItem>): TaskHistoryItem => ({
  id, taskId: "t", projectKey: "k-demo", at: NOW - id * 60_000, actor: actor("user", "You"), via: "ppm", unattended: false,
  kind: "updated", changes: [], reason: null, undoOf: null, undoneBy: null, undoable: false, ...over,
});

const HISTORY: TaskHistoryItem[] = [
  row(1, { actor: actor("manager", "Manager demo"), changes: [{ field: "urgency", before: "today", after: "now" }], reason: "CI is failing", undoable: true }),
  row(2, { actor: actor("manager", "Manager demo"), changes: [{ field: "importance", before: "must", after: "should" }], undoneBy: 9 }),
  row(3, { actor: actor("user", "You"), kind: "closed", via: "telegram" }),
  row(4, { actor: actor("assistant", "Assistant"), kind: "created", unattended: true, undoable: true }),
];

const SETTINGS: TaskProjectSettings = {
  project: { name: "demo", projectKey: "k-demo", enabled: true, hasManager: true, open: 3, now: 1, enabledBy: "user", checkIntervalMin: 30 },
  statuses: [
    { id: "todo", projectKey: "k-demo", name: "To do", baseGroup: "not_started", closedAs: null, position: 0 },
    { id: "prog", projectKey: "k-demo", name: "In progress", baseGroup: "active", closedAs: null, position: 1 },
  ],
  members: [{ id: "m1", projectKey: "k-demo", name: "Minh Anh", jiraAccountId: "minh.anh", githubLogin: "minhanh-dev", slackUserId: null, position: 0, archivedAt: null }],
  fieldDefs: [
    { projectKey: "k-demo", key: "sprint", label: "Sprint", type: "number", options: null, position: 0 },
    { projectKey: "k-demo", key: "customer", label: "Customer", type: "select", options: ["Acme Payroll", "Other"], position: 1 },
  ],
};

function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown = [];
    if (url.includes("/history")) {
      const filter = new URL(url, "http://x").searchParams.get("filter");
      data = filter === "ai" ? HISTORY.filter((h) => h.actor.kind !== "user") : filter === "status" ? HISTORY.filter((h) => h.kind !== "updated") : HISTORY;
    }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const task = taskDto({
  title: "PSR Ireland bỏ sót payslip", statusId: "prog", statusName: "In progress", baseGroup: "active",
  urgency: "today", effectiveUrgency: "now", urgencyRaised: true, importance: "must", dueDate: "2026-11-17",
  why: "Export drops payslips", nextStep: "Fix the period-13 filter", notes: "Acme noticed 41 missing",
  tags: ["payroll", "ireland"], assigneeMemberId: "m1",
  fields: { sprint: 47, customer: "Acme Payroll", hmrc_ref: "IE-2026-11-0412", affected_count: 41 },
  links: [{ kind: "jira", ref: "NX-6318", label: null }, { kind: "pr", ref: "nxsys/backend#2231", label: null }],
  result: { text: "Filter fixed, CI green", at: NOW, by: "Manager demo" },
});

describe("TaskDetailDesktop", () => {
  it("shows every field, declared fields typed and undeclared ones raw", async () => {
    serve();
    view = await mount(<TaskDetailDesktop detail={{ task, children: [], linkStates: [] }} settings={SETTINGS} preview />);
    await settle();
    const text = document.body.textContent ?? "";
    for (const s of ["PSR Ireland bỏ sót payslip", "In progress", "Must", "Export drops payslips", "Fix the period-13 filter",
      "Acme noticed 41 missing", "Filter fixed, CI green", "NX-6318", "backend#2231", "payroll", "ireland", "Jira minh.anh",
      "Preview · edit to keep the tab", "Sprint", "Customer", "not declared"]) {
      expect(text).toContain(s);
    }
    expect(document.querySelector("[data-urgency-hint]")?.textContent).toContain("Raised from Today by the due date");
    expect(document.querySelector('[data-urgency="now"]')?.getAttribute("data-raised")).toBe("auto");
    expect((document.querySelector('[aria-label="Sprint (number)"]') as HTMLInputElement).value).toBe("47");
    expect((document.querySelector('[aria-label="Customer (select)"]') as HTMLSelectElement).value).toBe("Acme Payroll");
    expect(document.querySelector('[data-undeclared-field="hmrc_ref"]')?.textContent).toContain('"IE-2026-11-0412"');
    expect(document.querySelector('[data-undeclared-field="affected_count"]')?.textContent).toContain("41");
    expect(document.querySelector('[data-undeclared-field="sprint"]')).toBeNull();
    expect((document.querySelector('[aria-label="Assignee"]') as HTMLSelectElement).value).toBe("m1");
  });

  it("offers Undo only on AI changes that can still be undone", async () => {
    serve();
    view = await mount(<TaskDetailDesktop detail={{ task, children: [], linkStates: [] }} settings={SETTINGS} preview={false} />);
    await settle();
    const rows = [...document.querySelectorAll("[data-history-id]")];
    expect(rows.map((r) => r.getAttribute("data-history-id"))).toEqual(["1", "2", "3", "4"]);
    const undo = (id: string) => !!document.querySelector(`[data-history-id="${id}"] button`);
    expect([undo("1"), undo("2"), undo("3"), undo("4")]).toEqual([true, false, false, true]);
    expect(document.querySelector('[data-history-id="2"]')?.getAttribute("data-undone")).toBe("true");
    expect(document.querySelector('[data-history-id="4"] [data-unattended]')).not.toBeNull();
    expect(document.querySelector('[data-history-id="1"]')?.textContent).toContain("changed urgency Today → Now");
    expect(document.querySelector('[data-history-id="3"]')?.textContent).toContain("from Telegram");
    expect(document.body.textContent).not.toContain("Preview · edit to keep the tab");
  });
});
