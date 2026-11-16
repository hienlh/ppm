/**
 * A click on a task's code copies the full code (`alpha/82`, which any chat understands wherever it
 * is pasted), says "Copied" and stops there: the row or chip around it does not open as well. The
 * list row and the chat chip show the code the view calls for (`#82` in the task's own project,
 * `alpha/82` across projects).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";

installDom();
afterAll(uninstallDom);
const { TaskCode } = await import("../../../../src/web/components/ppm-tasks/kit/task-code");
const { TaskListRow } = await import("../../../../src/web/components/ppm-tasks/task-list-row");
const { ComposerTaskChipRow } = await import("../../../../src/web/components/chat/task-ref-chip");
const { taskCodeItem } = await import("../../../../src/web/components/layout/command-palette-task-code");
const { taskTabTitle } = await import("../../../../src/web/lib/ppm-tasks/open-task-tab");

let view: Mounted | null = null;
let copied: string[] = [];
let toasts: ReturnType<typeof spyOn>[] = [];
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  toasts = [spyOn(toast, "success").mockImplementation(() => 0), spyOn(toast, "error").mockImplementation(() => 0)];
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const t of toasts) t.mockRestore();
  if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TaskCode", () => {
  it("copies the full code and says so, without opening what it sits in", async () => {
    let opened = 0;
    view = await mount(
      <div onClick={() => opened++}>
        <TaskCode task={{ number: 82, project: "alpha" }} viewProject="alpha" />
      </div>,
    );
    const code = document.querySelector("[data-task-code]")!;
    expect(code.textContent).toBe("#82");
    expect(code.getAttribute("title")).toBe("Copy alpha/82");
    await click(code);
    await settle();
    expect(copied).toEqual(["alpha/82"]);
    expect(toasts[0]!.mock.calls[0]?.[0]).toBe("Copied alpha/82");
    expect(opened).toBe(0);
  });

  it("inside another button is a span with the button role, copying by keyboard too", async () => {
    let opened = 0;
    view = await mount(
      <button type="button" onClick={() => opened++}>
        <TaskCode task={{ number: 3, project: "beta" }} viewProject={null} nested />
      </button>,
    );
    const code = document.querySelector("[data-task-code]") as HTMLElement;
    expect(code.tagName).toBe("SPAN");
    expect(code.getAttribute("role")).toBe("button");
    expect(code.textContent).toBe("beta/3");
    code.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(copied).toEqual(["beta/3"]);
    expect(opened).toBe(0);
  });
});

describe("where the code shows", () => {
  const noop = () => {};
  const row = (showProject: boolean, onSelect = noop) => (
    <TaskListRow task={taskDto({ project: "alpha", number: 82, title: "Pay run" })} depth={0} selected={false} showProject={showProject}
      onSelect={onSelect} onOpenChat={noop} onStartChat={noop} />
  );

  it("a list row shows #N in its project's list and project/N in all projects", async () => {
    view = await mount(row(false));
    expect(document.querySelector("[data-task-row] [data-task-code]")?.textContent).toBe("#82");
    await view.unmount();
    view = await mount(row(true));
    expect(document.querySelector("[data-task-row] [data-task-code]")?.textContent).toBe("alpha/82");
  });

  it("a click on a row's code copies it and does not open the task", async () => {
    let selected = 0;
    view = await mount(row(false, () => { selected++; }));
    await click(document.querySelector("[data-task-row] [data-task-code]"));
    await settle();
    expect(copied).toEqual(["alpha/82"]);
    expect(selected).toBe(0);
  });

  it("the composer's chip names its own project's task #N and another project's project/N", async () => {
    const chip = (project: string, number: number) => ({ taskId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, number, ref: `${project}/${number}`, title: "Fix login", project });
    view = await mount(<ComposerTaskChipRow chips={[chip("alpha", 12), chip("beta", 4)]} currentProject="alpha" onRemove={noop} />);
    expect([...document.querySelectorAll("[data-task-chip] [data-task-code]")].map((e) => e.textContent)).toEqual(["#12", "beta/4"]);
  });
});

describe("names that carry the code", () => {
  it("a task tab reads code then title, the project named only from another project's panel", () => {
    const t = { number: 82, project: "alpha", title: "Pay run" };
    expect(taskTabTitle(t, "alpha")).toBe("#82 Pay run");
    expect(taskTabTitle(t, "beta")).toBe("alpha/82 Pay run");
    expect(taskTabTitle(t, null)).toBe("alpha/82 Pay run");
  });

  it("a palette row found by code reads the same way and opens the task", () => {
    const task = taskDto({ project: "alpha", number: 82, title: "Pay run", statusName: "In progress" });
    let closed = 0;
    expect(taskCodeItem(task, "alpha", () => closed++)).toMatchObject({ label: "#82 Pay run", hint: "Task · alpha · In progress", group: "action" });
    expect(taskCodeItem(task, "beta", () => closed++).label).toBe("alpha/82 Pay run");
  });
});
