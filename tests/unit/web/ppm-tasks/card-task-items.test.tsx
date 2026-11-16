/**
 * The two task cards in "Waiting on you": the "while you were away" card offers a real Undo per
 * change (one history row each; a settings change says it cannot be undone; an undo the server
 * says was already made stops being offered), and the handed-off work card an Open chat per task.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { CardTaskChanges, CardHandedOffTasks } = await import("../../../../src/web/components/assistant/cards/card-task-items");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let posts: string[] = [];
afterEach(async () => { await view?.unmount(); view = null; posts = []; globalThis.fetch = realFetch; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function serve(undo: (id: string) => { status: number; json: unknown }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /\/api\/tasks\/history\/(\d+)\/undo$/.exec(url);
    if (init?.method === "POST") posts.push(url);
    const r = m ? undo(m[1]!) : { status: 200, json: { ok: true, data: [] } };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const CHANGES = [
  { historyId: 11, taskId: "t1", ref: "demo/1", summary: 'demo/1 "Pay run": closed' },
  { historyId: 12, taskId: "t2", ref: "demo/2", summary: 'demo/2 "RTI": urgency now' },
  { historyId: null, taskId: null, ref: null, summary: "demo settings: added member Bob" },
];

describe("CardTaskChanges", () => {
  it("undoes exactly the change pressed, then shows it undone", async () => {
    serve(() => ({ status: 200, json: { ok: true, data: { task: taskDto(), managerPrompt: false } } }));
    view = await mount(<CardTaskChanges changes={CHANGES} />);
    const buttons = [...document.querySelectorAll("[data-card-task-change] button:not([data-task-code])")];
    expect(buttons).toHaveLength(2);
    expect(document.querySelector('[data-card-task-change="settings"]')?.textContent).toContain("cannot be undone");
    await click(buttons[1]!);
    await settle();
    expect(posts).toEqual(["/api/tasks/history/12/undo"]);
    expect(document.querySelector('[data-card-task-change="12"]')?.getAttribute("data-undone")).toBe("true");
    expect(document.querySelector('[data-card-task-change="11"] button:not([data-task-code])')).not.toBeNull();
  });

  it("stops offering an undo the server says was already made", async () => {
    serve(() => ({ status: 403, json: { ok: false, code: "forbidden", error: "This change was already undone" } }));
    view = await mount(<CardTaskChanges changes={CHANGES.slice(0, 1)} />);
    await click(document.querySelector("[data-card-task-change] button:not([data-task-code])"));
    await settle();
    expect(document.querySelector('[data-card-task-change="11"]')?.getAttribute("data-undone")).toBe("true");
  });
});

describe("CardHandedOffTasks", () => {
  it("lists each task with its code, its title when the card carries it, and its own Open chat", async () => {
    view = await mount(<CardHandedOffTasks projectName="demo" tasks={[{ taskId: "t1", sessionId: "s1", ref: "demo/1", title: "Pay run" }, { taskId: "t2", sessionId: "s2", ref: "demo/2" }]} />);
    const items = [...document.querySelectorAll("[data-card-tasks] li")];
    expect(items.map((li) => li.textContent)).toEqual(["demo/1Pay runOpen chat", "demo/2Open chat"]);
    expect([...document.querySelectorAll("[data-card-tasks] [data-task-code]")].map((e) => e.textContent)).toEqual(["demo/1", "demo/2"]);
  });
});

describe("a change's code", () => {
  it("is drawn as a code (spanning projects: project/N) ahead of the rest of the sentence", async () => {
    serve(() => ({ status: 200, json: { ok: true, data: [] } }));
    view = await mount(<CardTaskChanges changes={CHANGES} />);
    expect(document.querySelector('[data-card-task-change="11"] [data-task-code]')?.textContent).toBe("demo/1");
    expect(document.querySelector('[data-card-task-change="11"] p')?.textContent).toBe('demo/1"Pay run": closed');
    // A settings change names no task: its summary is left as it is.
    expect(document.querySelector('[data-card-task-change="settings"] [data-task-code]')).toBeNull();
  });

  it("splits only a summary that starts with its own code", async () => {
    const { splitChangeSummary } = await import("../../../../src/web/components/assistant/cards/card-task-items");
    expect(splitChangeSummary({ ref: "demo/1", summary: 'demo/1 "Pay run": closed' })).toEqual({ ref: "demo/1", rest: '"Pay run": closed' });
    expect(splitChangeSummary({ ref: "demo/1", summary: "settings changed" })).toBeNull();
    expect(splitChangeSummary({ ref: null, summary: "demo/1 x" })).toBeNull();
  });
});
