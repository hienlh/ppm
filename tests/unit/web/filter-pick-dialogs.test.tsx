/**
 * ⋮ Choose value and ⋯ Lookup: a list read from the server as a search is typed, ticked in any
 * order across searches, and written into the filter box on OK as one exact value each.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { ValueLookupDialog } = await import("../../../src/web/components/database/grid/value-lookup-dialog.tsx");
const { DictionaryLookupDialog } = await import("../../../src/web/components/database/grid/dictionary-lookup-dialog.tsx");
const { FilterDialogHost } = await import("../../../src/web/components/database/grid/filter-dialog-host.tsx");
const { FilterCell } = await import("../../../src/web/components/database/grid/filter-row.tsx");
const { columnFilterState } = await import("../../../src/web/components/database/grid/grid-filters.ts");
const { PICK_SEARCH_DELAY_MS } = await import("../../../src/web/components/database/grid/use-pick-search.ts");
type LookupSource = import("../../../src/web/components/database/grid/dictionary-lookup-dialog.tsx").LookupSource;
type FilterGroup = import("../../../src/shared/db-grid.ts").FilterGroup;
type FilterableColumn = import("../../../src/shared/db-filter-parser.ts").FilterableColumn;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
// By attribute rather than a selector, so a label may hold quotes.
const byLabel = <T extends HTMLElement>(label: string) => [...document.body.querySelectorAll<T>("[aria-label]")].find((el) => el.getAttribute("aria-label") === label) ?? null;
const button = (text: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent === text)!;
const focusedLabel = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null;
/** The rows as shown: each row's cells, NULL and the empty text as they read. */
const listed = () => [...document.body.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(1).map((td) => td.textContent));
const ticked = () => [...document.body.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.getAttribute("aria-label"));
const note = () => document.body.querySelector("table")!.nextElementSibling?.textContent ?? null;

/** Lets the answers already given land. */
const settle = () => act(async () => { await Bun.sleep(0); });
const pause = () => act(async () => { await Bun.sleep(PICK_SEARCH_DELAY_MS + 40); });

async function setValue(el: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

async function pressEnter(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
}

/** A server that answers each search when told to, so an order of answers can be staged. */
function server<T>() {
  const asked: string[] = [];
  const pending: { search: string; resolve: (v: T) => void; reject: (e: Error) => void }[] = [];
  return {
    asked,
    load: (search: string) => new Promise<T>((resolve, reject) => { asked.push(search); pending.push({ search, resolve, reject }); }),
    async answer(search: string, value: T) {
      const i = pending.findIndex((p) => p.search === search);
      if (i < 0) throw new Error(`nothing asked for "${search}"`);
      pending.splice(i, 1)[0].resolve(value);
      await settle();
    },
    async fail(search: string, message: string) {
      const i = pending.findIndex((p) => p.search === search);
      pending.splice(i, 1)[0].reject(new Error(message));
      await settle();
    },
  };
}

const values = (list: unknown[], hasMore = false) => ({ values: list, hasMore, sql: "" });

describe("Choose value", () => {
  async function renderValues(kind: import("../../../src/shared/db-column-kind.ts").ColumnKind = "text") {
    const s = server<ReturnType<typeof values>>();
    const out = { submitted: [] as string[], closed: 0 };
    view = await mount(
      <ValueLookupDialog column="status" kind={kind} load={s.load} onSubmit={(t) => out.submitted.push(t)} onClose={() => out.closed++} />,
    );
    return { s, out };
  }

  it("lists the column's values, NULL and the empty text marked, and writes the ones ticked in the order ticked", async () => {
    const { s, out } = await renderValues();
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Choose value from status");
    expect(s.asked).toEqual([""]);
    expect(note()).toBe("Loading…");
    await s.answer("", values([null, "", "active", 'say "hi"']));
    expect(listed()).toEqual([["NULL"], ["(empty)"], ["active"], ['say "hi"']]);
    await click(byLabel('Pick say "hi"'));
    await click(byLabel("Pick active"));
    await click(byLabel("Pick NULL"));
    expect(ticked()).toEqual(["Pick NULL", "Pick active", 'Pick say "hi"']);
    await click(button("OK"));
    expect(out).toEqual({ submitted: ['="say ""hi""",="active",NULL'], closed: 1 });
  });

  it("ticks from anywhere on a row, and a second tick takes it back", async () => {
    const { s, out } = await renderValues();
    await s.answer("", values(["a", "b"]));
    const rowA = document.body.querySelector("tbody tr")!;
    await click(rowA.querySelector("td:last-child"));
    expect(ticked()).toEqual(["Pick a"]);
    await click(rowA.querySelector("td:last-child"));
    expect(ticked()).toEqual([]);
    await click(byLabel("Pick b"));
    await click(button("OK"));
    expect(out.submitted).toEqual(['="b"']);
  });

  it("searches once typing pauses, at once on Enter without OK-ing, and keeps what was ticked", async () => {
    const { s, out } = await renderValues();
    await s.answer("", values(["active", "pending"]));
    await click(byLabel("Pick pending"));
    const search = byLabel("Search values")!;
    await setValue(search, "clo");
    expect(s.asked).toEqual([""]);
    await pause();
    expect(s.asked).toEqual(["", "clo"]);
    await s.answer("clo", values(["closed"]));
    expect(listed()).toEqual([["closed"]]);
    await click(byLabel("Pick closed"));

    await setValue(search, "  act ");
    await pressEnter(search);
    expect(dialog()).not.toBeNull();
    expect(s.asked).toEqual(["", "clo", "  act "]);
    await s.answer("  act ", values(["active"]));
    await click(byLabel("Pick active"));
    await click(button("OK"));
    expect(out.submitted).toEqual(['="pending",="closed",="active"']);
  });

  it("drops an answer to a search no longer in the box", async () => {
    const { s } = await renderValues();
    await s.answer("", values(["a"]));
    const search = byLabel("Search values")!;
    await setValue(search, "x");
    await pressEnter(search);
    await setValue(search, "xy");
    await pressEnter(search);
    await s.answer("xy", values(["xy1"]));
    await s.answer("x", values(["x1", "x2"]));
    expect(listed()).toEqual([["xy1"]]);
  });

  it("says why the list is empty, cut short, or could not be read", async () => {
    const { s } = await renderValues();
    await s.answer("", values([]));
    expect(note()).toBe("No values to choose from.");
    const search = byLabel("Search values")!;
    await setValue(search, " zz ");
    await pressEnter(search);
    // The old answer is still shown while the new one loads, and is not called a miss for it.
    expect(note()).toBe("No values to choose from.");
    await s.answer(" zz ", values([]));
    expect(note()).toBe("Nothing matches “zz”.");
    await setValue(search, "a");
    await pressEnter(search);
    await s.answer("a", values(["a1"], true));
    expect(note()).toBe("Showing the first 100 values. Search to find the others.");
    await setValue(search, "b");
    await pressEnter(search);
    await s.fail("b", "permission denied for table orders");
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe("permission denied for table orders");
    expect(listed()).toEqual([]);
    // Asked again, the list is loading rather than still failing.
    await setValue(search, "c");
    await pressEnter(search);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(note()).toBe("Loading…");
  });

  it("writes a boolean column's values as TRUE and FALSE", async () => {
    const { s, out } = await renderValues("boolean");
    await s.answer("", values([false, true, 1]));
    await click(byLabel("Pick true"));
    await click(byLabel("Pick false"));
    await click(byLabel("Pick 1"));
    await click(button("OK"));
    expect(out.submitted).toEqual(["TRUE,FALSE,TRUE"]);
  });

  it("tells a number from its text where a column holds both", async () => {
    const { s, out } = await renderValues("other");
    await s.answer("", values([1, "1"]));
    expect(document.body.querySelectorAll("tbody tr").length).toBe(2);
    await click(document.body.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')[1]);
    expect(document.body.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')[0].checked).toBe(false);
    await click(button("OK"));
    expect(out.submitted).toEqual(['="1"']);
  });

  it("writes nothing when nothing is ticked, or on Close", async () => {
    const { s, out } = await renderValues();
    await s.answer("", values(["a"]));
    await click(button("OK"));
    expect(out).toEqual({ submitted: [], closed: 1 });
    await view!.unmount();
    const again = await renderValues();
    await again.s.answer("", values(["a"]));
    await click(byLabel("Pick a"));
    await click(button("Close"));
    expect(again.out).toEqual({ submitted: [], closed: 1 });
  });

  it("starts on the search", async () => {
    await renderValues();
    expect(focusedLabel()).toBe("Search values");
  });
});

describe("Lookup", () => {
  const PLAN_COLUMNS: FilterableColumn[] = [
    { name: "id", kind: "number" },
    { name: "price", kind: "number" },
    { name: "code", kind: "text" },
    { name: "name", kind: "text" },
  ];
  const PLANS = [
    { id: 1, price: 9, code: "basic", name: "Basic plan" },
    { id: 2, price: 19, code: "pro", name: "Pro plan" },
    { id: 3, price: 49, code: null, name: "Team plan" },
  ];

  async function renderLookup(over: Partial<LookupSource> = {}, columns: Promise<FilterableColumn[]> = Promise.resolve(PLAN_COLUMNS), pick?: (value: unknown) => void) {
    const rows = server<{ rows: Record<string, unknown>[]; hasMore: boolean }>();
    const searched: FilterGroup[][] = [];
    const chosen: string[] = [];
    const out = { submitted: [] as string[], closed: 0 };
    const source: LookupSource = {
      table: "plans",
      keyColumn: "id",
      columns: () => columns,
      rows: (anyColumn) => { searched.push(anyColumn); return rows.load(JSON.stringify(anyColumn)); },
      description: null,
      onDescription: (c) => chosen.push(c),
      ...over,
    };
    view = await mount(pick
      ? <DictionaryLookupDialog source={source} kind="number" onPick={pick} onClose={() => out.closed++} />
      : <DictionaryLookupDialog source={source} kind="number" onSubmit={(t) => out.submitted.push(t)} onClose={() => out.closed++} />);
    await settle();
    return { rows, searched, chosen, out, answer: (anyColumn: FilterGroup[], list = PLANS, hasMore = false) => rows.answer(JSON.stringify(anyColumn), { rows: list, hasMore }) };
  }

  const headers = () => [...document.body.querySelectorAll("thead th")].slice(1).map((th) => th.textContent);

  it("lists the referenced table by its key and the first text column, and writes the keys ticked", async () => {
    const { searched, answer, out } = await renderLookup();
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Lookup from plans");
    expect(searched).toEqual([[]]);
    await answer([]);
    expect(headers()).toEqual(["Value", "Description"]);
    expect(listed()).toEqual([["1", "basic"], ["2", "pro"], ["3", "NULL"]]);
    await click(byLabel("Pick 3"));
    await click(byLabel("Pick 1 basic"));
    await click(button("OK"));
    expect(out).toEqual({ submitted: ['="3",="1"'], closed: 1 });
  });

  it("searches the key and the description and no other column, reading the text as itself", async () => {
    const { searched, answer } = await renderLookup();
    await answer([]);
    const search = byLabel("Search plans")!;
    await setValue(search, "9");
    await pressEnter(search);
    // `9` is a price too, but only id and code are shown, so only they are searched.
    expect(searched[1].map((g) => g.column).sort()).toEqual(["code", "id"]);
    await answer(searched[1], [PLANS[0]]);
    await setValue(search, "pro");
    await pressEnter(search);
    expect(searched[2].map((g) => g.column)).toEqual(["code"]);
    expect(searched[2][0].anyOf).toEqual([[{ op: "contains", value: "pro" }]]);
  });

  it("asks for nothing when neither column can read the search", async () => {
    const { searched, answer } = await renderLookup({}, Promise.resolve([{ name: "id", kind: "number" }, { name: "at", kind: "datetime" }]));
    await answer([]);
    expect(headers()).toEqual(["Value"]);
    const search = byLabel("Search plans")!;
    await setValue(search, "abc");
    await pressEnter(search);
    await settle();
    expect(searched.length).toBe(1);
    expect(listed()).toEqual([]);
    expect(note()).toBe("Nothing matches “abc”.");
  });

  it("shows the description chosen before while the table still has it", async () => {
    const { answer } = await renderLookup({ description: "name" });
    await answer([]);
    expect(listed()[1]).toEqual(["2", "Pro plan"]);
    await view!.unmount();
    const gone = await renderLookup({ description: "title" });
    await gone.answer([]);
    expect(listed()[1]).toEqual(["2", "pro"]);
  });

  it("picks the description with Customize, remembers it, and lists the table by it", async () => {
    const { searched, chosen, answer } = await renderLookup();
    await answer([]);
    const customize = button("Customize");
    expect(customize.getAttribute("aria-expanded")).toBe("false");
    expect(byLabel("Description column")).toBeNull();
    await click(customize);
    expect(customize.getAttribute("aria-expanded")).toBe("true");
    const select = byLabel<HTMLSelectElement>("Description column")!;
    expect(customize.getAttribute("aria-controls")).toBe(select.closest("label")!.id);
    expect([...select.options].map((o) => o.value)).toEqual(["price", "code", "name"]);
    expect(select.value).toBe("code");
    await setValue(select, "name");
    expect(chosen).toEqual(["name"]);
    expect(searched.length).toBe(2);
    await answer([]);
    expect(listed()[0]).toEqual(["1", "Basic plan"]);
    await setValue(byLabel("Search plans")!, "Team");
    await pressEnter(byLabel("Search plans")!);
    expect(searched[2].map((g) => g.column)).toEqual(["name"]);
  });

  it("keeps Customize shut until the columns are read, and says why when they cannot be", async () => {
    let fail!: (e: Error) => void;
    await renderLookup({}, new Promise((_, reject) => { fail = reject; }));
    expect(button("Customize").disabled).toBe(true);
    await act(async () => { fail(new Error("relation \"plans\" does not exist")); await Bun.sleep(0); });
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe('relation "plans" does not exist');
    expect(button("Customize").disabled).toBe(true);
  });

  it("picks one row for a cell: a second tick takes the first's place, and OK puts its key in", async () => {
    const picked: unknown[] = [];
    const { answer, out } = await renderLookup({}, Promise.resolve(PLAN_COLUMNS), (v) => picked.push(v));
    await answer([]);
    await click(byLabel("Pick 1 basic"));
    await click(byLabel("Pick 2 pro"));
    expect(ticked()).toEqual(["Pick 2 pro"]);
    // Ticked again, it is picked no more.
    await click(byLabel("Pick 2 pro"));
    expect(ticked()).toEqual([]);
    await click(byLabel("Pick 3"));
    await click(button("OK"));
    expect(picked).toEqual([3]);
    expect(out.closed).toBe(1);
  });

  it("puts nothing in a cell when OK is pressed with no row picked", async () => {
    const picked: unknown[] = [];
    const { answer, out } = await renderLookup({}, Promise.resolve(PLAN_COLUMNS), (v) => picked.push(v));
    await answer([]);
    await click(button("OK"));
    // Not even an undefined: that would put NULL in the cell.
    expect(picked).toHaveLength(0);
    expect(out.closed).toBe(1);
  });

  it("says when the table is empty or cut short", async () => {
    const { answer, out } = await renderLookup();
    await answer([], [], false);
    expect(note()).toBe("plans has no rows.");
    await click(button("OK"));
    expect(out).toEqual({ submitted: [], closed: 1 });
    await view!.unmount();
    const more = await renderLookup();
    await more.answer([], PLANS, true);
    expect(note()).toBe("Showing the first 100 rows. Search to find the others.");
  });
});

describe("⋮ and ⋯ in a filter box", () => {
  /** A filter cell whose ⋮ or ⋯ opens its dialog through the host, as the table view's does. */
  async function mountCell(picker: "values" | "lookup", load: () => Promise<unknown>) {
    const { useState } = await import("react");
    const lookup: LookupSource = {
      table: "plans", keyColumn: "id",
      columns: async () => [{ name: "id", kind: "number" }, { name: "code", kind: "text" }],
      rows: () => load() as ReturnType<LookupSource["rows"]>,
      description: null, onDescription: () => {},
    };
    function Harness() {
      const [open, setOpen] = useState<Parameters<typeof FilterDialogHost>[0]["open"]>(null);
      const [value, setValue] = useState("");
      return (
        <>
          <FilterCell
            value={value}
            read={(text) => columnFilterState({ text }, "number")}
            onCommit={setValue}
            label="Filter plan_id"
            chooseValues={picker === "values" ? {
              column: "plan_id",
              onOpen: (returnFocus) => setOpen({ column: "plan_id", returnFocus, request: { dialog: "values", column: "plan_id", kind: "number", load: load as never } }),
            } : undefined}
            lookup={picker === "lookup" ? {
              table: "plans",
              onOpen: (returnFocus) => setOpen({ column: "plan_id", returnFocus, request: { dialog: "lookup", kind: "number", source: lookup } }),
            } : undefined}
          />
          <FilterDialogHost open={open} onClose={() => setOpen(null)} onSubmit={(_, text) => setValue(text)} />
        </>
      );
    }
    view = await mount(<Harness />);
    return byLabel<HTMLInputElement>("Filter plan_id")!;
  }

  it("⋮ writes the values picked into the box it was opened from, and focus goes back there", async () => {
    const box = await mountCell("values", async () => values([1, 2]));
    await click(byLabel("Choose value from plan_id"));
    await settle();
    await click(byLabel("Pick 2"));
    await click(button("OK"));
    await act(async () => { await Bun.sleep(5); });
    expect(box.value).toBe('="2"');
    expect(focusedLabel()).toBe("Filter plan_id");
  });

  it("⋯ writes the keys picked into the box it was opened from, and focus goes back there", async () => {
    const box = await mountCell("lookup", async () => ({ rows: [{ id: 7, code: "pro" }], hasMore: false }));
    await click(byLabel("Lookup from plans"));
    await settle();
    expect(listed()).toEqual([["7", "pro"]]);
    await click(byLabel("Pick 7 pro"));
    await click(button("OK"));
    await act(async () => { await Bun.sleep(5); });
    expect(box.value).toBe('="7"');
    expect(focusedLabel()).toBe("Filter plan_id");
  });
});
