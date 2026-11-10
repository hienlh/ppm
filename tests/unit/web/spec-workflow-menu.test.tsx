/**
 * The Workflow group under the Modes menu: a new chat picks its workflow there, an existing chat
 * with no spec starts one bound to itself, and a chat with a spec shows it.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { SpecWorkflowContext, SpecWorkflowMenuSection, SpecWorkflowChip } = await import("../../../src/web/components/spec/spec-workflow.tsx");
const { DEFAULT_SPEC_START } = await import("../../../src/web/lib/api-specs.ts");
type State = import("../../../src/web/components/spec/spec-workflow.tsx").SpecWorkflowState;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const base = (over: Partial<State>): State => ({
  choice: DEFAULT_SPEC_START, setChoice: () => {}, locked: false, boundTitle: null, boundChecks: null, ...over,
});
const render = (state: State, onDone = () => {}) => mount(
  <SpecWorkflowContext.Provider value={state}>
    <SpecWorkflowMenuSection onDone={onDone} />
    <SpecWorkflowChip />
  </SpecWorkflowContext.Provider>,
);
const option = (name: string) => [...view!.container.querySelectorAll("[role=option]")].find((b) => b.textContent?.startsWith(name)) ?? null;

it("a new chat picks its workflow and the menu closes", async () => {
  const picked: string[] = [];
  let closed = 0;
  view = await render(base({ setChoice: (c) => picked.push(c.workflow) }), () => closed++);
  expect(view.container.textContent).toContain("Workflow");
  await click(option("Quick Spec"));
  expect(picked).toEqual(["quick"]);
  expect(closed).toBe(1);
});

it("the composer chip shows only while a workflow is on", async () => {
  view = await render(base({}));
  expect(view.container.querySelector("[aria-haspopup=listbox]")).toBeNull();
  await view.rerender(
    <SpecWorkflowContext.Provider value={base({ choice: { ...DEFAULT_SPEC_START, workflow: "spec" } })}>
      <SpecWorkflowChip />
    </SpecWorkflowContext.Provider>,
  );
  expect(view.container.querySelector("[aria-haspopup=listbox]")?.getAttribute("title")).toContain("Spec");
});

it("an existing chat with no spec starts one bound to itself", async () => {
  const started: string[] = [];
  view = await render(base({ locked: true, onStartHere: async (c) => { started.push(`${c.workflow}/${c.checks}`); } }));
  expect(view.container.textContent).toContain("Turn this chat into a spec");
  expect(option("Chat")?.hasAttribute("disabled")).toBe(true);
  await click(option("Bug Fix"));
  expect(started).toEqual(["bugfix/standard"]);
});

it("an existing chat that cannot start one shows no group", async () => {
  view = await render(base({ locked: true }));
  expect(view.container.textContent).not.toContain("Workflow");
});

it("a chat bound to a spec shows it and toggles its pane", async () => {
  let toggled = 0;
  view = await render(base({ locked: true, boundTitle: "Export CSV", boundChecks: "thorough", paneOpen: true, onTogglePane: () => toggled++ }));
  expect(view.container.textContent).toContain("Spec: Export CSV");
  expect(view.container.textContent).toContain("Hide the spec");
  await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Spec: Export CSV")) ?? null);
  expect(toggled).toBe(1);
});
