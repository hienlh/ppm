/**
 * The form view as a user drives it: fields laid out in pairs to the height, the row's place in its
 * corner, arrows between names and values, Ctrl+arrows through the rows, a letter or Enter editing
 * a value that goes into the change set only once it reads as the column's type, a letter on a
 * name typing the Column name filter, ⊞ on a foreign key showing the row it refers to, and the
 * form icon opening that row in a tab of its own.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { FormView } = await import("../../../src/web/components/database/grid/form-view.tsx");
const { EMPTY_CHANGESET, addRows, deleteRows, editCells } = await import("../../../src/web/components/database/grid/grid-changeset.ts");
type FormViewProps = import("../../../src/web/components/database/grid/form-view.tsx").FormViewProps;
type ReferencedRow = import("../../../src/web/components/database/grid/form-view.tsx").ReferencedRow;
type FormMenuTarget = import("../../../src/web/components/database/grid/form-view.tsx").FormMenuTarget;
type CellChange = import("../../../src/web/components/database/grid/grid-changeset.ts").CellChange;
type GridColumnSchema = import("../../../src/web/components/database/glide-grid-types.ts").GridColumnSchema;

const SCHEMA: GridColumnSchema[] = [
  { name: "id", type: "integer", nullable: false, pk: true },
  { name: "name", type: "text", nullable: false, pk: false },
  { name: "qty", type: "integer", nullable: true, pk: false },
  { name: "active", type: "boolean", nullable: true, pk: false },
  { name: "photo", type: "bytea", nullable: true, pk: false },
  { name: "user_id", type: "integer", nullable: true, pk: false, fk: { table: "users", column: "id" } },
  { name: "meta", type: "jsonb", nullable: true, pk: false },
];
const ROW: Record<string, unknown> = { id: 1, name: "Ann", qty: 3, active: true, photo: { $binary: "AAEC", size: 3 }, user_id: 11, meta: { a: 1 } };
const OTHER: Record<string, unknown> = { id: 2, name: "Bo", qty: null, active: null, photo: null, user_id: 12, meta: null };
const USERS: ReferencedRow = {
  columns: [{ name: "email", type: "text", nullable: false, pk: false }, { name: "city", type: "text", nullable: true, pk: false }],
  row: { email: "ann@example.com", city: null },
};
const COUNT = { text: "Rows: 14", counting: false, canCountExactly: false, total: { kind: "exact" as const, count: 14 } };

let view: Mounted | null = null;
let restoreHeight: (() => void) | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  restoreHeight?.();
  restoreHeight = null;
});

/** What the form told the grid, in order. */
interface Calls {
  log: string[];
  edits: CellChange[][];
  menus: [{ x: number; y: number }, FormMenuTarget][];
  opened: [string, Record<string, unknown>][];
  loads: [string, unknown][];
  fields: string[];
}

function props(calls: Calls, over: Partial<FormViewProps>): FormViewProps {
  return {
    table: "orders", row: ROW, index: 1, rowsShown: 14, loaded: 14, rowCount: COUNT, schema: SCHEMA, pkCol: "id",
    changeset: EMPTY_CHANGESET,
    // As the grid decides: a saved row's key cannot change.
    canEdit: (_row, column) => column !== "id",
    onEdit: (c) => { calls.edits.push(c); calls.log.push(`edit ${c.map((e) => `${e.column}=${JSON.stringify(e.value)}`).join(",")}`); },
    initialField: "name", onFieldChange: (c) => calls.fields.push(c),
    nameFilter: "",
    onNavigate: (to) => calls.log.push(`navigate ${to}`),
    onFilterValue: (column, value) => calls.log.push(`filter ${column}=${JSON.stringify(value)}`),
    onSave: () => calls.log.push("save"),
    onMenu: (at, target) => calls.menus.push([at, target]),
    loadReference: (column, row) => { calls.loads.push([column, row[column]]); return Promise.resolve(USERS); },
    onOpenReference: (column, row) => calls.opened.push([column, row]),
    ...over,
  };
}

function newCalls(): Calls {
  return { log: [], edits: [], menus: [], opened: [], loads: [], fields: [] };
}

async function form(over: Partial<FormViewProps> = {}) {
  const calls = newCalls();
  view = await mount(<FormView {...props(calls, over)} />);
  return calls;
}

/** As the grid holds the Column name filter: in state, so what is typed adds up. */
async function formWithNameFilter(over: Partial<FormViewProps> = {}) {
  const calls = newCalls();
  function Held() {
    const [text, setText] = useState("");
    return <FormView {...props(calls, over)} nameFilter={text} onNameFilterChange={(t) => { calls.log.push(`name filter "${t}"`); setText(t); }} />;
  }
  view = await mount(<Held />);
  return calls;
}

/** The box measured `px` tall, as a browser lays it out; happy-dom measures everything 0. */
function measuredHeight(px: number) {
  const proto = window.HTMLElement.prototype;
  const before = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => px });
  restoreHeight = () => Object.defineProperty(proto, "offsetHeight", before);
}

const grid = () => document.body.querySelector<HTMLElement>('[role="grid"]')!;
const pairs = () => [...grid().querySelectorAll("table")];
/** A line's column name: the name cell holds ⊞ (or room for it), the column's icon, its name, its type. */
const nameOf = (header: Element) => header.querySelector("div")!.children[2]!.textContent;
const names = (scope: Element = grid()) => [...scope.querySelectorAll('[role="rowheader"]')].map(nameOf);
const line = (column: string) => [...grid().querySelectorAll("tr")].find((tr) => nameOf(tr.querySelector('[role="rowheader"]')!) === column)!;
const nameCell = (column: string) => line(column).querySelector<HTMLElement>('[role="rowheader"]')!;
const valueCell = (column: string) => line(column).querySelector<HTMLElement>('[role="gridcell"]')!;
/** Where the cursor is: the field's column, and whether on its name or its value. */
function cursor(): [string, "name" | "value"] {
  const at = document.getElementById(grid().getAttribute("aria-activedescendant")!)!;
  return [nameOf(at.closest("tr")!.querySelector('[role="rowheader"]')!)!, at.getAttribute("role") === "rowheader" ? "name" : "value"];
}
const editor = () => grid().querySelector<HTMLInputElement>("input[data-cell-editor]");
const button = (label: string) => grid().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

async function press(key: string, init: KeyboardEventInit = {}, target: Element = grid()) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}
async function type(text: string) {
  const input = editor()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mouse(type: "mousedown" | "contextmenu", target: Element, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  });
}
/** Lets a reference read settle: its promise, then the render it causes. */
const settle = () => act(async () => { await Promise.resolve(); });

describe("the layout", () => {
  it("puts as many fields down each pair as the height holds, then starts a new pair to the right", async () => {
    // 142px: 22 are kept for the row label, the rest is four 30px lines.
    measuredHeight(142);
    const schema = Array.from({ length: 30 }, (_, i) => ({ name: `c${String(i + 1).padStart(2, "0")}`, type: "text", nullable: true, pk: false }));
    await form({ schema, row: Object.fromEntries(schema.map((c) => [c.name, c.name.toUpperCase()])), initialField: null });
    expect(pairs().map((t) => t.querySelectorAll("tr").length)).toEqual([4, 4, 4, 4, 4, 4, 4, 2]);
    expect(names(pairs()[0]!)).toEqual(["c01", "c02", "c03", "c04"]);
    expect(names(pairs()[7]!)).toEqual(["c29", "c30"]);
    expect(valueCell("c30").textContent).toBe("C30");
  });

  it("shows every column of the table in its order, with the row's values as the grid shows them", async () => {
    await form();
    expect(pairs()).toHaveLength(1);
    expect(names()).toEqual(SCHEMA.map((c) => c.name));
    expect(SCHEMA.map((c) => valueCell(c.name).textContent)).toEqual(["1", "Ann", "3", "true", "3 bytes · 00 01 02", "11", '{"a":1}']);
    expect(grid().getAttribute("aria-label")).toBe("orders as a form");
  });

  it("says where the row is among the table's rows, and that there is none to show", async () => {
    await form();
    expect(document.body.querySelector('[role="status"]')!.textContent).toBe("Row: 2 / 14");
    await view!.unmount();
    await form({ row: undefined, index: 0, rowsShown: 0, loaded: 0 });
    expect(document.body.querySelector('[role="grid"]')).toBeNull();
    expect(document.body.querySelector('[role="status"]')!.textContent).toBe("No data");
  });

  it("shows an edited value with what it was, a row to be deleted struck through, and a new row's unset fields as (No Field)", async () => {
    await form({ changeset: editCells(EMPTY_CHANGESET, [{ row: ROW, column: "name", value: "Anna" }], "id", ["id"]) });
    expect(valueCell("name").textContent).toBe("Anna");
    expect(valueCell("name").title).toBe("Was: Ann");
    expect(valueCell("qty").title).toBe("");
    await view!.unmount();

    await form({ changeset: deleteRows(EMPTY_CHANGESET, [ROW], "id", ["id"]) });
    expect([...grid().querySelectorAll("tr")].every((tr) => tr.className.includes("line-through"))).toBe(true);
    await view!.unmount();

    const fresh = { id: "__new_1" };
    const changeset = editCells(addRows(EMPTY_CHANGESET, [fresh]), [{ row: fresh, column: "name", value: "Dee" }], "id", ["id"]);
    await form({ row: fresh, index: 14, rowsShown: 15, changeset });
    expect(document.body.querySelector('[role="status"]')!.textContent).toBe("New row 1");
    expect(["id", "name", "qty"].map((c) => valueCell(c).textContent)).toEqual(["(No Field)", "Dee", "(No Field)"]);
    // A new row's fields are its own: nothing to say what they were.
    expect(valueCell("name").title).toBe("");
  });
});

describe("the cursor", () => {
  it("starts on the value of the column the grid's cursor was on, and walks names and values with the arrows", async () => {
    const calls = await form({ initialField: "qty" });
    expect(cursor()).toEqual(["qty", "value"]);
    await press("ArrowLeft");
    expect(cursor()).toEqual(["qty", "name"]);
    await press("ArrowDown");
    expect(cursor()).toEqual(["active", "name"]);
    await press("ArrowRight");
    expect(cursor()).toEqual(["active", "value"]);
    await press("Home");
    expect(cursor()).toEqual(["id", "name"]);
    // The grid's cursor follows it, column by column.
    expect(calls.fields.at(-1)).toBe("id");
    expect(calls.fields).toContain("active");
  });

  it("moves to a cell clicked, and a click on the value it is on already edits it", async () => {
    await form();
    await mouse("mousedown", valueCell("qty"));
    expect(cursor()).toEqual(["qty", "value"]);
    expect(editor()).toBeNull();
    await mouse("mousedown", valueCell("qty"));
    expect(editor()!.value).toBe("3");
    // Any button but the first leaves the cursor where it is.
    await press("Escape", {}, editor()!);
    await mouse("mousedown", nameCell("id"), { button: 2 });
    expect(cursor()).toEqual(["qty", "value"]);
  });

  it("takes the keys once it appears when the user switched to it", async () => {
    await form({ autoFocus: true });
    expect(document.activeElement).toBe(grid());
  });
});

describe("the row's keys", () => {
  it("are First, Previous, Next and Last on Ctrl+Home, Ctrl+↑, Ctrl+↓ and Ctrl+End, and on ⌘ too", async () => {
    const calls = await form();
    await press("Home", { ctrlKey: true });
    await press("ArrowUp", { ctrlKey: true });
    await press("ArrowDown", { metaKey: true });
    await press("End", { ctrlKey: true });
    // With Shift they are not the row's.
    await press("ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(calls.log).toEqual(["navigate first", "navigate previous", "navigate next", "navigate last"]);
    expect(cursor()).toEqual(["name", "value"]);
  });

  it("filters by the value under the cursor on Ctrl+Shift+F, as it reads now", async () => {
    const calls = await form({ initialField: "qty", changeset: editCells(EMPTY_CHANGESET, [{ row: ROW, column: "qty", value: 8 }], "id", ["id"]) });
    await press("F", { ctrlKey: true, shiftKey: true });
    expect(calls.log).toEqual(["filter qty=8"]);
  });
});

describe("editing a value", () => {
  it("starts from a letter typed, puts the value in on Enter and goes down a field", async () => {
    const calls = await form();
    await press("B");
    expect(editor()!.value).toBe("B");
    expect(editor()!.getAttribute("aria-label")).toBe("Edit name");
    await type("Bob");
    await press("Enter", {}, editor()!);
    expect(calls.edits).toEqual([[{ row: ROW, column: "name", value: "Bob" }]]);
    expect(editor()).toBeNull();
    expect(cursor()).toEqual(["qty", "value"]);
    // Left by a key: the form has its keys back.
    expect(document.activeElement).toBe(grid());
  });

  it("puts a number column's value in as a number, and nothing while what is typed is not one", async () => {
    const calls = await form({ initialField: "qty" });
    await press("Enter");
    expect(editor()!.value).toBe("3");
    await type("12abc");
    expect(editor()!.getAttribute("aria-invalid")).toBe("true");
    await press("Enter", {}, editor()!);
    expect(calls.edits).toEqual([]);
    expect(editor()).not.toBeNull();
    await type("12");
    expect(editor()!.getAttribute("aria-invalid")).toBeNull();
    await press("Tab", {}, editor()!);
    // A number too long for JavaScript goes as typed, for the database to read.
    await press("F2");
    await type("9007199254740993");
    await press("Enter", {}, editor()!);
    expect(calls.edits).toEqual([[{ row: ROW, column: "qty", value: 12 }], [{ row: ROW, column: "qty", value: "9007199254740993" }]]);
  });

  it("leaves the value as it was on Escape, and puts nothing in when it was not changed", async () => {
    const calls = await form();
    await press("F2");
    await type("Zed");
    await press("Escape", {}, editor()!);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(grid());
    await press("Enter");
    await press("Enter", {}, editor()!);
    expect(calls.edits).toEqual([]);
    expect(cursor()).toEqual(["qty", "value"]);
    // A JSON value opens as its text, which left alone is no change either.
    await press("End");
    await press("Enter");
    expect(editor()!.value).toBe('{"a":1}');
    await press("Enter", {}, editor()!);
    expect(calls.edits).toEqual([]);
  });

  it("puts the value in when the editor loses focus another way", async () => {
    const calls = await form();
    await press("Enter");
    await type("Cat");
    await act(async () => { editor()!.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
    expect(calls.edits).toEqual([[{ row: ROW, column: "name", value: "Cat" }]]);
    expect(editor()).toBeNull();
  });

  it("puts the value in before saving on Ctrl+S, and does not save one that cannot go in", async () => {
    const calls = await form({ initialField: "qty" });
    await press("Enter");
    await type("x");
    await press("s", { ctrlKey: true }, editor()!);
    expect(calls.log).toEqual([]);
    await type("7");
    await press("s", { ctrlKey: true }, editor()!);
    expect(calls.log).toEqual(["edit qty=7", "save"]);
  });

  it("does not open on a value that cannot change: a saved row's key, bytes, a row the grid closed", async () => {
    await form({ initialField: "id" });
    await press("Enter");
    await press("7");
    expect(editor()).toBeNull();
    expect(valueCell("id").getAttribute("aria-readonly")).toBe("true");
    expect(valueCell("photo").getAttribute("aria-readonly")).toBe("true");
    expect(valueCell("name").getAttribute("aria-readonly")).toBeNull();
    await mouse("mousedown", valueCell("photo"));
    await mouse("mousedown", valueCell("photo"));
    expect(editor()).toBeNull();
  });

  it("sets NULL on Ctrl+0 wherever the value can change, bytes included, and not on a name", async () => {
    const calls = await form({ initialField: "photo" });
    await press("0", { ctrlKey: true });
    await press("ArrowUp");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("0", { ctrlKey: true });
    await press("ArrowLeft");
    await press("0", { ctrlKey: true });
    await press("Home");
    await press("ArrowRight");
    await press("0", { ctrlKey: true });
    expect(cursor()).toEqual(["id", "value"]);
    expect(calls.edits).toEqual([[{ row: ROW, column: "photo", value: null }], [{ row: ROW, column: "name", value: null }]]);
  });

  it("puts nothing in where the value is NULL already", async () => {
    const calls = await form({ row: OTHER, initialField: "qty" });
    await press("0", { ctrlKey: true });
    expect(calls.edits).toEqual([]);
  });

  it("closes when another row is shown, rather than putting its text into that row", async () => {
    const calls = newCalls();
    let show!: (row: Record<string, unknown>, index: number) => void;
    function Walk() {
      const [at, setAt] = useState({ row: ROW, index: 1 });
      show = (row, index) => setAt({ row, index });
      return <FormView {...props(calls, at)} />;
    }
    view = await mount(<Walk />);
    await press("Enter");
    expect(editor()).not.toBeNull();
    await act(async () => { show(OTHER, 2); });
    expect(editor()).toBeNull();
    expect(valueCell("name").textContent).toBe("Bo");
  });
});

describe("the Column name filter", () => {
  it("is typed on a name, lights the names it matches, and is cleared by Escape", async () => {
    const calls = await formWithNameFilter({ initialField: "id" });
    await press("ArrowLeft");
    await press("m");
    await press("e");
    expect(calls.log).toEqual(['name filter "m"', 'name filter "me"']);
    const lit = () => SCHEMA.map((c) => c.name).filter((c) => nameCell(c).className.includes("bg-warning/20"));
    expect(lit()).toEqual(["name", "meta"]);
    // ↑ and ↓ on a name go through the matching names only.
    await press("ArrowDown");
    expect(cursor()).toEqual(["name", "name"]);
    await press("ArrowDown");
    expect(cursor()).toEqual(["meta", "name"]);
    await press("Escape");
    expect(calls.log.at(-1)).toBe('name filter ""');
    expect(lit()).toEqual([]);
  });

  it("is not typed where the grid keeps none: a letter on a name does nothing", async () => {
    const calls = await form({ initialField: "id" });
    await press("ArrowLeft");
    await press("q");
    expect(editor()).toBeNull();
    expect(calls.log).toEqual([]);
  });
});

describe("a foreign key", () => {
  it("shows the referenced row's columns under it on NumPad +, read only, and hides them on NumPad −", async () => {
    const calls = await form({ initialField: "user_id" });
    await press("+", { code: "NumpadAdd" });
    await settle();
    expect(calls.loads).toEqual([["user_id", 11]]);
    expect(names()).toEqual(["id", "name", "qty", "active", "photo", "user_id", "email", "city", "meta"]);
    expect(["email", "city"].map((c) => valueCell(c).textContent)).toEqual(["ann@example.com", "(NULL)"]);
    expect(valueCell("email").getAttribute("aria-readonly")).toBe("true");
    expect(button("Collapse user_id")!.getAttribute("aria-expanded")).toBe("true");

    // Nothing here changes, filters by or edits the referenced row.
    await press("ArrowDown");
    expect(cursor()).toEqual(["email", "value"]);
    await press("Enter");
    await press("0", { ctrlKey: true });
    await press("F", { ctrlKey: true, shiftKey: true });
    expect(editor()).toBeNull();
    expect(calls.edits).toEqual([]);
    expect(calls.log).toEqual([]);
    await mouse("contextmenu", valueCell("email"), { clientX: 30, clientY: 40 });
    expect(calls.menus).toEqual([[{ x: 30, y: 40 }, { column: "email", referenced: true, onName: false, value: "ann@example.com" }]]);

    await press("ArrowUp");
    await press("-", { code: "NumpadSubtract" });
    expect(names()).toEqual(SCHEMA.map((c) => c.name));
    // Shown again for the same key, the row is not read again.
    await click(button("Expand user_id"));
    await settle();
    expect(names()).toContain("email");
    expect(calls.loads).toHaveLength(1);
  });

  it("leaves the cursor on its field as the referenced row's lines open and close above it, and puts it on the key when they close under it", async () => {
    await form({ initialField: "meta" });
    await click(button("Expand user_id"));
    await settle();
    expect(names()).toContain("email");
    expect(cursor()).toEqual(["meta", "value"]);
    await click(button("Collapse user_id"));
    expect(cursor()).toEqual(["meta", "value"]);

    await click(button("Expand user_id"));
    await settle();
    await mouse("mousedown", nameCell("city"));
    expect(cursor()).toEqual(["city", "name"]);
    await click(button("Collapse user_id"));
    expect(cursor()).toEqual(["user_id", "name"]);
  });

  it("closes again, and says so, when the referenced row cannot be read", async () => {
    const calls = await form({ loadReference: (column) => { calls.loads.push([column, null]); return Promise.reject(new Error("no access")); } });
    await click(button("Expand user_id"));
    await settle();
    expect(calls.loads).toHaveLength(1);
    expect(button("Expand user_id")!.getAttribute("aria-expanded")).toBe("false");
    expect(names()).not.toContain("email");
  });

  it("reads the referenced row again for every row shown, and when the row is read again", async () => {
    const calls = newCalls();
    let show!: (row: Record<string, unknown>, index: number) => void;
    function Walk() {
      const [at, setAt] = useState({ row: ROW, index: 1 });
      show = (row, index) => setAt({ row, index });
      return <FormView {...props(calls, at)} />;
    }
    view = await mount(<Walk />);
    await click(button("Expand user_id"));
    await settle();
    await act(async () => { show(OTHER, 2); });
    await settle();
    // Refresh: the same key, but the row it refers to may have changed since.
    await act(async () => { show({ ...OTHER }, 2); });
    await settle();
    expect(calls.loads).toEqual([["user_id", 11], ["user_id", 12], ["user_id", 12]]);
    expect(names()).toContain("email");
  });

  it("has no ⊞ where no other table can be read", async () => {
    await form({ loadReference: undefined, initialField: "user_id" });
    expect(button("Expand user_id")).toBeNull();
    await press("+", { code: "NumpadAdd" });
    expect(names()).toEqual(SCHEMA.map((c) => c.name));
  });

  it("opens the referenced row as a form from the icon in its value, by the value it holds now", async () => {
    const calls = await form({ changeset: editCells(EMPTY_CHANGESET, [{ row: ROW, column: "user_id", value: 12 }], "id", ["id"]) });
    await click(button("Open the users row as a form"));
    expect(calls.opened).toHaveLength(1);
    expect(calls.opened[0]![0]).toBe("user_id");
    expect(calls.opened[0]![1]).toMatchObject({ id: 1, user_id: 12 });
    // Clicking it leaves the cursor where it was.
    expect(cursor()).toEqual(["name", "value"]);
  });

  it("has no icon where its value is NULL, or where the grid cannot open another tab", async () => {
    await form({ row: { ...OTHER, user_id: null } });
    expect(button("Open the users row as a form")).toBeNull();
    await view!.unmount();
    await form({ onOpenReference: undefined });
    expect(button("Open the users row as a form")).toBeNull();
  });
});

describe("the menu and the clipboard", () => {
  it("opens on a right-click with the field under it, moving the cursor there", async () => {
    const calls = await form();
    await mouse("contextmenu", valueCell("qty"), { clientX: 5, clientY: 6, button: 2 });
    await mouse("contextmenu", nameCell("meta"), { clientX: 7, clientY: 8, button: 2 });
    expect(calls.menus).toEqual([
      [{ x: 5, y: 6 }, { column: "qty", referenced: false, onName: false, value: 3 }],
      [{ x: 7, y: 8 }, { column: "meta", referenced: false, onName: true, value: { a: 1 } }],
    ]);
    expect(cursor()).toEqual(["meta", "name"]);
  });

  it("copies a value as the grid copies a cell, and a name as itself", async () => {
    await form({ initialField: "meta" });
    await press("c", { ctrlKey: true });
    await settle();
    expect(await navigator.clipboard.readText()).toBe('{"a":1}');
    await press("ArrowLeft");
    await press("c", { ctrlKey: true });
    await settle();
    expect(await navigator.clipboard.readText()).toBe("meta");
  });
});
