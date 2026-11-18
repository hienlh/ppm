/**
 * The task page's Result block: who-and-when and Edit share one header row, and only who-and-when
 * gives way. Edit used to be laid over the block from outside (`absolute right-2 top-2`), so a long
 * name and a full date ran underneath it and neither could be read. A browser measures the boxes
 * (tests/e2e/task-detail-meta-e2e.mjs); this pins the classes that make it hold.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { click, mount, type Mounted } from "../../helpers/react-dom.tsx";
import type { TaskDto } from "../../../src/shared/ppm-tasks-api.ts";

const { TaskResultCard } = await import("../../../src/web/components/ppm-tasks/task-result-card");
const { TaskNotesCard } = await import("../../../src/web/components/ppm-tasks/task-notes-card");

const BY = "Manager Nxsys Payroll — Quarterly Close Reconciliation Assistant";
const task = (over: Partial<TaskDto> = {}) => ({
  id: "t1", notes: "", result: { text: "Merged #11221", at: 1_800_000_000_000, by: BY },
  workingSession: { kind: "none" }, handedOffAt: null, ...over,
}) as unknown as TaskDto;

let mounted: Mounted | null = null;
afterEach(async () => { await mounted?.unmount(); mounted = null; });

const classes = (el: Element | null) => new Set((el?.getAttribute("class") ?? "").split(/\s+/));

describe("Result header: who-and-when beside Edit", () => {
  it("puts Edit inside the header row, after who-and-when, not laid over the block", async () => {
    mounted = await mount(<TaskResultCard task={task()} onSave={() => {}} />);
    const header = mounted.container.querySelector("[data-task-result] > header")!;
    const meta = header.querySelector("[data-task-result-meta]");
    const action = header.querySelector("[data-task-result-action]");
    expect(meta).not.toBeNull();
    expect(action?.textContent).toContain("Edit");
    expect(meta!.compareDocumentPosition(action!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mounted.container.querySelector(".absolute")).toBeNull();
  });

  it("cuts who-and-when with an ellipsis and carries the full text in its tooltip", async () => {
    mounted = await mount(<TaskResultCard task={task()} onSave={() => {}} />);
    const meta = mounted.container.querySelector("[data-task-result-meta]")!;
    for (const c of ["truncate", "min-w-0"]) expect(classes(meta).has(c)).toBe(true);
    expect(meta.getAttribute("title")).toBe(meta.textContent);
    expect(meta.getAttribute("title")).toContain(BY);
  });

  it("keeps Edit at its width", async () => {
    mounted = await mount(<TaskResultCard task={task()} onSave={() => {}} />);
    const action = mounted.container.querySelector("[data-task-result-action]")!;
    expect(classes(action).has("shrink-0")).toBe(true);
    const button = action.querySelector("[data-card-text-button]")!;
    for (const c of ["shrink-0", "whitespace-nowrap"]) expect(classes(button).has(c)).toBe(true);
  });

  it("Edit still opens the editor", async () => {
    mounted = await mount(<TaskResultCard task={task()} onSave={() => {}} />);
    await click(mounted.container.querySelector("[data-card-text-button]")!);
    expect(mounted.container.querySelector('textarea[aria-label="Result"]')).not.toBeNull();
  });

  it("every card's text action keeps its width (Notes' Edit too)", async () => {
    mounted = await mount(<TaskNotesCard task={task({ notes: "x" } as Partial<TaskDto>)} onSave={() => {}} />);
    const button = mounted.container.querySelector("[data-card-text-button]")!;
    for (const c of ["h-7", "shrink-0", "whitespace-nowrap"]) expect(classes(button).has(c)).toBe(true);
  });
});
