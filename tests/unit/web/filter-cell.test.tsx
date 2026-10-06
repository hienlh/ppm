/**
 * The filter row's cell commits on Enter and when focus leaves it, never per keystroke; Esc
 * clears it; a paste of several lines becomes one filter; the buttons follow the text typed.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside the funnel's dropdown, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { FilterCell } = await import("../../../src/web/components/database/grid/filter-row.tsx");
const { columnFilterState } = await import("../../../src/web/components/database/grid/grid-filters.ts");
type Props = import("../../../src/web/components/database/grid/filter-row.tsx").FilterCellProps;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const readNumber = (text: string) => columnFilterState({ text }, "number");

async function render(props: Partial<Props> = {}) {
  const commits: string[] = [];
  const all: Props = { value: "", read: readNumber, onCommit: (t) => commits.push(t), label: "Filter qty", ...props };
  view = await mount(<FilterCell {...all} />);
  return { commits };
}

// Read off the cell this file mounted, never the whole document: the DOM is shared by every file
// in the run, and one that leaves its markup behind would otherwise put its buttons in this list.
const input = () => view!.container.querySelector<HTMLInputElement>('input[aria-label="Filter qty"]')!;
const buttons = () => [...view!.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));

async function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}

async function blur() {
  await act(async () => { /* React hears blur as focusout */ input().dispatchEvent(new Event("focusout", { bubbles: true })); });
}

type Funnel = NonNullable<Props["funnel"]>;
const funnel = (onDialog: Funnel["onDialog"] = () => {}): Funnel => ({ kind: "number", label: "Filter options: qty", onDialog });

/** Radix opens a dropdown on a primary-button pointerdown. */
async function openFunnel(): Promise<HTMLElement> {
  const trigger = view!.container.querySelector('button[aria-label="Filter options: qty"]')!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("the funnel did not open");
  return menu;
}
const menuLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((i) => (i.getAttribute("role") === "separator" ? "—" : i.textContent));
async function choose(menu: HTMLElement, label: string) {
  const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === label)!;
  await click(item);
}

async function paste(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  await act(async () => { input().dispatchEvent(event); });
  return event;
}

describe("the filter cell", () => {
  it("does not commit while typing, and commits on Enter", async () => {
    const { commits } = await render();
    await type(">=5");
    await type(">=5 <=10");
    expect(commits).toEqual([]);
    await press("Enter");
    expect(commits).toEqual([">=5 <=10"]);
  });

  it("commits when focus leaves it, only if the text changed", async () => {
    const { commits } = await render({ value: "5" });
    await blur();
    expect(commits).toEqual([]);
    await type("6");
    await blur();
    expect(commits).toEqual(["6"]);
  });

  it("clears on Esc", async () => {
    const { commits } = await render({ value: "5" });
    await type("56");
    await press("Escape");
    expect(commits).toEqual([""]);
    expect(input().value).toBe("");
  });

  it("is green while the text reads and rose when it does not, before anything is committed", async () => {
    await render();
    expect(input().className).toContain("focus:border-primary");
    await type(">=5");
    expect(input().className).toContain("text-success");
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(input().className).not.toContain("focus:border-");
    await type(">=");
    expect(input().className).toContain("text-error");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    // The box being edited keeps its colour: focus does not paint over it.
    expect(input().className).not.toContain("focus:border-");
  });

  it("still commits a text that does not read, so it is kept where it was typed", async () => {
    const { commits } = await render();
    await type(">=");
    await press("Enter");
    expect(commits).toEqual([">="]);
  });

  it("shows a filter switched off as off, and the server's refusal as an error", async () => {
    await render({ value: "5", off: true });
    expect(input().className).toContain("line-through");
    await view!.unmount();
    view = await mount(<FilterCell value="5" read={readNumber} onCommit={() => {}} label="Filter qty" serverError="permission denied" />);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    // Typing something else is no longer what the server refused.
    await type("6");
    expect(input().getAttribute("aria-invalid")).toBe("false");
  });

  it("shows no refusal on a box left empty, and keeps a text that does not read rose when switched off", async () => {
    view = await mount(<FilterCell value="" read={readNumber} onCommit={() => {}} label="Filter qty" serverError="permission denied" />);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    await view.unmount();
    view = await mount(<FilterCell value=">=" off read={readNumber} onCommit={() => {}} label="Filter qty" />);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().className).not.toContain("line-through");
  });

  it("puts the caret on the part that does not read when Enter is pressed", async () => {
    await render();
    await type("5 >=");
    await press("Enter");
    expect([input().selectionStart, input().selectionEnd]).toEqual([2, 4]);
  });

  it("explains what does not read while the box is focused or under the pointer, and only then", async () => {
    await render({ value: ">=" });
    const tip = () => document.querySelector('[role="tooltip"]')?.textContent ?? null;
    expect(tip()).toBeNull();
    await act(async () => { input().dispatchEvent(new Event("focusin", { bubbles: true })); });
    expect(tip()).toContain("Expected a value");
    await blur();
    expect(tip()).toBeNull();
    const box = input().parentElement!;
    await act(async () => { box.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
    expect(tip()).toContain("Expected a value");
  });

  it("leaves the box for the rows on ↓", async () => {
    let left = 0;
    await render({ onArrowDown: () => left++ });
    await press("ArrowDown");
    expect(left).toBe(1);
  });

  it("turns a paste of several lines into one filter of those values", async () => {
    const { commits } = await render();
    const event = await paste("active\npending\n");
    expect(event.defaultPrevented).toBe(true);
    expect(commits).toEqual(["='active',='pending'"]);
    expect(input().value).toBe("='active',='pending'");
  });

  it("leaves a paste of one line to the box, and a paste of blank lines changes nothing", async () => {
    const { commits } = await render({ value: "5" });
    const event = await paste("active");
    expect(event.defaultPrevented).toBe(false);
    await paste("\n \n");
    expect(commits).toEqual([]);
    expect(input().value).toBe("5");
  });

  it("offers ⋮ and the funnel while empty, and only × once there is text", async () => {
    const opened: string[] = [];
    await render({ chooseValues: { column: "qty", onOpen: () => opened.push("values") }, funnel: funnel() });
    expect(buttons()).toEqual(["Choose value from qty", "Filter options: qty"]);
    await click(view!.container.querySelector('button[aria-label="Choose value from qty"]'));
    expect(opened).toEqual(["values"]);
    await type("5");
    expect(buttons()).toEqual(["Clear filter"]);
  });

  it("offers ⋯ in place of ⋮ on a foreign key", async () => {
    await render({ chooseValues: { column: "qty", onOpen: () => {} }, lookup: { table: "plans", onOpen: () => {} }, funnel: funnel() });
    expect(buttons()).toEqual(["Lookup from plans", "Filter options: qty"]);
  });

  it("lists the column type's filters in the funnel, and writes the one picked into the box", async () => {
    const { commits } = await render({ funnel: funnel() });
    const menu = await openFunnel();
    expect(view!.container.querySelector('button[aria-label="Filter options: qty"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(menuLabels(menu)).toEqual([
      "Clear Filter", "Filter multiple values", "Equals...", "Does Not Equal...", "Is Null", "Is Not Null",
      "—", "Greater Than...", "Greater Than Or Equal To...", "Less Than...", "Less Than Or Equal To...",
      "—", "SQL condition ...", "SQL condition - right side ...",
    ]);
    await choose(menu, "Is Not Null");
    expect(commits).toEqual(["NOT NULL"]);
    expect(input().value).toBe("NOT NULL");
    // The funnel went with the empty box; focus goes to the filter it wrote.
    await act(async () => { await Bun.sleep(5); });
    expect(document.activeElement).toBe(input());
  });

  it("asks for the dialog a \"...\" item needs, with the way back to the box", async () => {
    const asked: { request: unknown; back: () => void }[] = [];
    const { commits } = await render({ funnel: funnel((request, back) => asked.push({ request, back })) });
    await choose(await openFunnel(), "Greater Than...");
    expect(commits).toEqual([]);
    expect(asked.map((a) => a.request)).toEqual([{ dialog: "condition", kind: "number", first: ">", second: "=" }]);
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); asked[0]!.back(); });
    expect(document.activeElement).toBe(input());
  });

  it("clears with ×", async () => {
    const { commits } = await render({ value: "5" });
    await click(view!.container.querySelector('button[aria-label="Clear filter"]'));
    expect(commits).toEqual([""]);
    expect(input().value).toBe("");
  });

  it("shows a text committed elsewhere: in the Filters panel, or by a dialog", async () => {
    let commitElsewhere!: (text: string) => void;
    function Harness() {
      const [value, setValue] = useState("5");
      commitElsewhere = setValue;
      return <FilterCell value={value} read={readNumber} onCommit={() => {}} label="Filter qty" />;
    }
    view = await mount(<Harness />);
    await act(async () => { commitElsewhere("=7"); });
    expect(input().value).toBe("=7");
  });
});
