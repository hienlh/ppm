/**
 * A task chip — in the composer, or on a sent message — shows the task's quick view anchored to
 * the chip instead of leaving for the task: a second click on the chip, Escape or a press outside
 * closes it; the composer chip's remove button still removes.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";

installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { ComposerTaskChipRow, TaskRefChipRow } = await import("../../../../src/web/components/chat/task-ref-chip");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

let task: TaskDto;
function serve(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://x").pathname;
    let data: unknown = [];
    if (path === `/api/tasks/${task.id}`) data = { task, children: [], linkStates: [] };
    else if (path.endsWith("/settings")) data = { project: {}, statuses: [], members: [], fieldDefs: [] };
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

afterEach(async () => { await view?.unmount(); view = null; globalThis.fetch = realFetch; });

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (el: Element | null) => { expect(el).not.toBeNull(); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const peek = () => $("[data-task-peek-popover]");

describe("task chips", () => {
  it("a sent message's chip shows the quick view, and a second click or Escape closes it", async () => {
    task = taskDto({ project: "alpha", title: "Fix the export" });
    serve();
    view = await mount(<TaskRefChipRow currentProject="alpha"
      refs={[{ taskId: task.id, projectName: "alpha", number: task.number, title: task.title, status: "To do" } as never]} />);
    const chip = $(`[data-task-ref="${task.id}"]`);
    await click(chip);
    expect(peek()?.getAttribute("data-task-peek-popover")).toBe(task.id);
    expect(chip?.getAttribute("aria-expanded")).toBe("true");
    expect($("[data-task-peek-page]")?.textContent).toBe("Open in window");
    await click(chip);
    expect(peek()).toBeNull();
    await click(chip);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    expect(peek()).toBeNull();
    await click(chip);
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await settle();
    expect(peek()).toBeNull();
  });

  it("the composer's chip shows the quick view, and its remove button still removes", async () => {
    task = taskDto({ project: "alpha", title: "Call the bank" });
    serve();
    const removed: string[] = [];
    view = await mount(<ComposerTaskChipRow currentProject="alpha" onRemove={(id) => removed.push(id)}
      chips={[{ taskId: task.id, number: task.number, ref: task.ref, title: task.title, project: "alpha" }]} />);
    await click($(`[data-task-chip="${task.id}"] [data-task-chip-open]`));
    expect(peek()?.getAttribute("data-task-peek-popover")).toBe(task.id);
    expect($("[data-task-peek-title]")?.textContent).toContain("Call the bank");
    await click($(`[data-task-chip="${task.id}"] [data-task-chip-remove]`));
    expect(removed).toEqual([task.id]);
  });

  it("a composer chip removed while its quick view is open takes the quick view with it", async () => {
    task = taskDto({ project: "alpha", title: "Call the bank" });
    const other = taskDto({ project: "alpha", title: "Draw the sprite" });
    serve();
    const { useState } = await import("react");
    const chipOf = (t: TaskDto) => ({ taskId: t.id, number: t.number, ref: t.ref, title: t.title, project: "alpha" });
    function Host() {
      const [chips, setChips] = useState([chipOf(task), chipOf(other)]);
      return <ComposerTaskChipRow currentProject="alpha" chips={chips} onRemove={(id) => setChips((c) => c.filter((x) => x.taskId !== id))} />;
    }
    view = await mount(<Host />);
    await click($(`[data-task-chip="${task.id}"] [data-task-chip-open]`));
    expect(peek()).not.toBeNull();
    await click($(`[data-task-chip="${task.id}"] [data-task-chip-remove]`));
    expect($(`[data-task-chip="${task.id}"]`)).toBeNull();
    expect(peek()).toBeNull();
  });
});
