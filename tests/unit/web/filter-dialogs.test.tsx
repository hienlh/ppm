/**
 * The funnel's dialogs only write filter text: Set filter joins two conditions, Filter multiple
 * values joins a list, and OK with nothing in them writes nothing. Focus goes back to the box.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { SetFilterDialog } = await import("../../../src/web/components/database/grid/set-filter-dialog.tsx");
const { FilterMultipleValuesDialog } = await import("../../../src/web/components/database/grid/filter-multiple-values-dialog.tsx");
const { FilterDialogHost } = await import("../../../src/web/components/database/grid/filter-dialog-host.tsx");
const { FilterCell } = await import("../../../src/web/components/database/grid/filter-row.tsx");
const { columnFilterState } = await import("../../../src/web/components/database/grid/grid-filters.ts");
type ConditionRequest = Extract<import("../../../src/web/components/database/grid/filter-funnel-menu.ts").FilterDialogRequest, { dialog: "condition" }>;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const byLabel = <T extends HTMLElement>(label: string) => document.body.querySelector<T>(`[aria-label="${label}"]`);
const button = (text: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === text)!;
/** Names what has focus, so a failure says where focus went rather than printing the document. */
const focusedLabel = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null;

/** Sets a field the way typing does, past React's own tracking of its value. */
async function setValue(el: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

async function renderSetFilter(request: Partial<ConditionRequest> = {}) {
  const out = { submitted: [] as string[], closed: 0, focused: 0 };
  const full: ConditionRequest = { dialog: "condition", kind: "number", first: ">", second: "=", ...request };
  view = await mount(
    <SetFilterDialog request={full} onSubmit={(t) => out.submitted.push(t)} onClose={() => out.closed++} returnFocus={() => out.focused++} />,
  );
  return out;
}

describe("Set filter", () => {
  it("opens on the comparison chosen, with the second on the column's default", async () => {
    await renderSetFilter({ kind: "date", first: ">=", second: "<=" });
    expect(dialog()!.textContent).toContain("Show rows where");
    expect(byLabel<HTMLSelectElement>("First condition")!.value).toBe(">=");
    expect(byLabel<HTMLSelectElement>("Second condition")!.value).toBe("<=");
    expect([...byLabel<HTMLSelectElement>("First condition")!.options].map((o) => o.textContent)).toEqual([
      "is before", "is after", "is before or equal", "is after or equal", "is NULL", "is not NULL", "SQL condition", "SQL condition - right side only",
    ]);
    expect(document.activeElement).toBe(byLabel("First value"));
  });

  it("writes both conditions, joined with AND unless Or is chosen", async () => {
    const out = await renderSetFilter({ kind: "date", first: ">=", second: "<=" });
    await setValue(byLabel("First value")!, "2026-09-05");
    await setValue(byLabel("Second value")!, "2026-09-10");
    await click(button("OK"));
    expect(out.submitted).toEqual([">=2026-09-05 <=2026-09-10"]);
    expect(out.closed).toBe(1);
  });

  it("joins with a comma for Or, and quotes text", async () => {
    const out = await renderSetFilter({ kind: "text", first: "^", second: "=" });
    await setValue(byLabel("First value")!, "ca");
    await click(byLabel("Join the two conditions")!.querySelector('input[value="or"]'));
    await setValue(byLabel("Second value")!, "united states");
    await click(button("OK"));
    expect(out.submitted).toEqual(['^"ca",="united states"']);
  });

  it("leaves Enter alone with a modifier held, or while an input method is composing", async () => {
    const out = await renderSetFilter();
    await setValue(byLabel("First value")!, "5");
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { isComposing: true }]) {
      await act(async () => {
        byLabel("First value")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
      });
    }
    expect(out).toMatchObject({ submitted: [], closed: 0 });
  });

  it("takes no value for NULL, and is OK on Enter", async () => {
    const out = await renderSetFilter();
    await setValue(byLabel<HTMLSelectElement>("Second condition")!, "NULL");
    expect(byLabel("Second value")).toBeNull();
    await setValue(byLabel("First value")!, "5");
    await act(async () => {
      byLabel("First value")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(out.submitted).toEqual([">5 NULL"]);
  });

  it("writes nothing when no condition says anything, and nothing on Close", async () => {
    const out = await renderSetFilter();
    await click(button("OK"));
    expect(out).toMatchObject({ submitted: [], closed: 1 });
    await view!.unmount();
    const closed = await renderSetFilter();
    await setValue(byLabel("First value")!, "5");
    await click(button("Close"));
    expect(closed).toMatchObject({ submitted: [], closed: 1 });
  });

  it("starts on the comparison when there is no value to type", async () => {
    await renderSetFilter({ kind: "boolean", first: "NULL", second: "sql" });
    expect(byLabel("First value")).toBeNull();
    expect(document.activeElement).toBe(byLabel("First condition"));
  });
});

describe("Filter multiple values", () => {
  async function renderLines() {
    const out = { submitted: [] as string[], closed: 0 };
    view = await mount(<FilterMultipleValuesDialog onSubmit={(t) => out.submitted.push(t)} onClose={() => out.closed++} />);
    return out;
  }

  it("writes one filter of the lines, in the way chosen", async () => {
    const out = await renderLines();
    expect(document.activeElement).toBe(byLabel("One value per line"));
    await setValue(byLabel("One value per line")!, "active\npending\n");
    await click(byLabel("Match")!.querySelector('input[value="isNot"]'));
    await click(button("OK"));
    expect(out.submitted).toEqual(["<>'active' <>'pending'"]);
  });

  it("is one of the lines unless told otherwise, and Enter starts a new line", async () => {
    const out = await renderLines();
    await setValue(byLabel("One value per line")!, "a");
    await act(async () => {
      byLabel("One value per line")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(out.submitted).toEqual([]);
    await click(button("OK"));
    expect(out.submitted).toEqual(["='a'"]);
  });

  it("writes nothing for no lines", async () => {
    const out = await renderLines();
    await setValue(byLabel("One value per line")!, "\n  \n");
    await click(button("OK"));
    expect(out).toEqual({ submitted: [], closed: 1 });
  });
});

describe("the dialog host", () => {
  it("writes into the column the dialog was opened for, and hands focus back when it closes", async () => {
    const submitted: [string | null, string][] = [];
    let focused = 0;
    const { useState } = await import("react");
    function Harness() {
      const [open, setOpen] = useState<Parameters<typeof FilterDialogHost>[0]["open"]>({ column: "status", request: { dialog: "lines" }, returnFocus: () => focused++ });
      return <FilterDialogHost open={open} onClose={() => setOpen(null)} onSubmit={(c, t) => submitted.push([c, t])} />;
    }
    view = await mount(<Harness />);
    await setValue(byLabel("One value per line")!, "x");
    await click(button("OK"));
    // Radix hands focus back once the dialog is gone, on the next turn of the event loop.
    await act(async () => { await Bun.sleep(5); });
    expect(submitted).toEqual([["status", "='x'"]]);
    expect(dialog()).toBeNull();
    expect(focused).toBe(1);
  });

  /** A filter cell whose funnel opens the dialogs, as the table view's does. */
  async function mountFunnelCell() {
    const { useState } = await import("react");
    function Harness() {
      const [open, setOpen] = useState<Parameters<typeof FilterDialogHost>[0]["open"]>(null);
      const [value, setValue] = useState("");
      return (
        <>
          <FilterCell
            value={value}
            read={(text) => columnFilterState({ text }, "number")}
            onCommit={setValue}
            label="Filter qty"
            funnel={{ kind: "number", label: "Filter options: qty", onDialog: (request, returnFocus) => setOpen({ column: "qty", request, returnFocus }) }}
          />
          <FilterDialogHost open={open} onClose={() => setOpen(null)} onSubmit={(_, text) => setValue(text)} />
        </>
      );
    }
    view = await mount(<Harness />);
    const box = byLabel<HTMLInputElement>("Filter qty")!;
    // Focus visiting the cell while a dialog is open would be pulled straight back by the
    // dialog, selecting whatever its field already held — and the next key would replace it.
    const visits = { cell: 0 };
    box.parentElement!.addEventListener("focusin", () => visits.cell++);
    return { box, visits };
  }

  async function chooseFromFunnel(label: string) {
    const trigger = document.querySelector('button[aria-label="Filter options: qty"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    });
    await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === label)!);
    // The menu's focus trap is still closing as the dialog opens, and has its last word a turn later.
    await act(async () => { await Bun.sleep(5); });
  }

  async function pressEnter(label: string) {
    await act(async () => {
      byLabel(label)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => { await Bun.sleep(5); });
  }

  it("starts Set filter on the value when the funnel opened it, and hands the filter and focus back to the box", async () => {
    const { box, visits } = await mountFunnelCell();
    await chooseFromFunnel("Greater Than...");
    expect(focusedLabel()).toBe("First value");
    expect(visits.cell).toBe(0);
    await setValue(byLabel("First value")!, "250");
    await pressEnter("First value");
    expect(dialog()).toBeNull();
    expect(box.value).toBe(">250");
    expect(focusedLabel()).toBe("Filter qty");
  });

  it("starts Filter multiple values on its list when the funnel opened it", async () => {
    const { box, visits } = await mountFunnelCell();
    await chooseFromFunnel("Filter multiple values");
    expect(focusedLabel()).toBe("One value per line");
    expect(visits.cell).toBe(0);
    await setValue(byLabel("One value per line")!, "3\n4");
    await click(button("OK"));
    await act(async () => { await Bun.sleep(5); });
    expect(box.value).toBe("='3',='4'");
    expect(focusedLabel()).toBe("Filter qty");
  });

  it("opens Set filter for a comparison", async () => {
    view = await mount(<FilterDialogHost open={{ column: null, request: { dialog: "condition", kind: "multi", first: "=", second: "=" }, returnFocus: () => {} }} onClose={() => {}} onSubmit={() => {}} />);
    expect(dialog()!.textContent).toContain("Set filter");
    expect([...byLabel<HTMLSelectElement>("First condition")!.options].map((o) => o.value)).not.toContain("sql");
  });
});

describe("a dialog opened from no filter box", () => {
  it("hands focus back to what had it: Fetch All Rows, asked for by Ctrl+End in the form, has no trigger to go back to", async () => {
    const { FetchAllDialog } = await import("../../../src/web/components/database/grid/fetch-all-dialog.tsx");
    const { useState } = await import("react");
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? <FetchAllDialog onFetch={() => {}} onClose={() => setOpen(false)} /> : null;
    }
    const opener = document.createElement("div");
    opener.tabIndex = 0;
    document.body.appendChild(opener);
    try {
      for (const text of ["Fetch All", "Close"]) {
        opener.focus();
        view = await mount(<Harness />);
        expect(dialog()?.textContent).toContain("Fetch All Rows");
        await click(button(text));
        await act(async () => { await Bun.sleep(5); });
        expect(dialog()).toBeNull();
        expect(document.activeElement).toBe(opener);
        await view.unmount();
        view = null;
      }
    } finally {
      opener.remove();
    }
  });
});
