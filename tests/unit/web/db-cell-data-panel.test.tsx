/**
 * DBGate's Cell data view as a user drives it: the format Autodetect picks for what is selected —
 * a Form for whole rows, Json for JSON, a Picture for an image's bytes — and the other formats from
 * the Format box, each saying so when the selection is not what it shows. One cell that can change
 * is typed into, and what is typed goes into the change set once it reads as the column's type and
 * the box is left; the Form's fields are edited in place, in every selected row. The docked view's
 * edge drags it between 220 and 560px, a floating one goes with Esc, and a phone's is a sheet.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { CompactSelection } = await import("@glideapps/glide-data-grid");
const panel = await import("../../../src/web/components/database/grid/cell-data-panel.tsx");
const { collectCellData } = await import("../../../src/web/components/database/grid/cell-data-formats.ts");
const { CellDataPanel, CellDataSheet, clampCellDataWidth, keepCellDataWidth, readCellDataWidth } = panel;
type CellDataSource = import("../../../src/web/components/database/grid/cell-data-panel.tsx").CellDataSource;
type CellChange = import("../../../src/web/components/database/grid/grid-changeset.ts").CellChange;
type GridColumnSchema = import("../../../src/web/components/database/glide-grid-types.ts").GridColumnSchema;
type GridSelection = import("@glideapps/glide-data-grid").GridSelection;

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13));
const SCHEMA: GridColumnSchema[] = [
  { name: "id", type: "integer", nullable: false, pk: true },
  { name: "name", type: "text", nullable: false, pk: false },
  { name: "qty", type: "integer", nullable: true, pk: false },
  { name: "prefs", type: "jsonb", nullable: true, pk: false },
  { name: "photo", type: "bytea", nullable: true, pk: false },
  { name: "note", type: "text", nullable: true, pk: false },
];
const COLUMNS = SCHEMA.map((c) => c.name);
const ROWS: Record<string, unknown>[] = [
  { id: 1, name: "Ann", qty: 3, prefs: { theme: "dark", tags: ["a", "b"] }, photo: { $binary: PNG, size: 12 }, note: null },
  { id: 2, name: "Bo", qty: 3, prefs: null, photo: { $binary: PNG, size: 90_000, truncated: true }, note: '{"x": 1}' },
  { id: 3, name: "Cy", qty: 5, prefs: null, photo: null, note: "<p>hi</p>" },
];

const cells = (x: number, y: number, width = 1, height = 1): GridSelection => ({
  columns: CompactSelection.empty(), rows: CompactSelection.empty(),
  current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
});
const wholeRows = (...rows: number[]): GridSelection => ({
  columns: CompactSelection.empty(), rows: rows.reduce((sel, r) => sel.add(r), CompactSelection.empty()),
});
const col = (name: string) => COLUMNS.indexOf(name);

/** What the view told the grid, in order. */
interface Calls {
  edits: CellChange[][];
  saves: number;
  widths: number[];
  closes: boolean[];
}
let calls: Calls;
let select: (sel: GridSelection) => void = () => {};
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  localStorage.clear();
});

/** The grid's side of the view, over rows that the edits it is sent do not change. */
function source(sel: GridSelection, over: Partial<CellDataSource>): CellDataSource {
  return {
    selection: collectCellData(sel, COLUMNS, ROWS.length, (r, c) => ROWS[r]![c]),
    columns: SCHEMA,
    record: (r) => ROWS[r]!,
    rowId: (r) => String(ROWS[r]!.id),
    rowValues: (r) => ROWS[r]!,
    // As the grid decides: a saved row's key cannot change.
    canEdit: (_row, column) => column !== "id",
    onEdit: (c) => calls.edits.push(c),
    onSave: () => { calls.saves += 1; },
    ...over,
  };
}

function Harness({ initial, floating, over }: { initial: GridSelection; floating: boolean; over: Partial<CellDataSource> }) {
  const [sel, setSel] = useState(initial);
  select = setSel;
  const [width, setWidth] = useState(300);
  return (
    <div>
      <CellDataPanel
        source={source(sel, over)} width={width} floating={floating}
        onWidthChange={(w) => { calls.widths.push(w); setWidth(w); }} onClose={(hadFocus) => calls.closes.push(hadFocus)}
      />
    </div>
  );
}

async function open(sel: GridSelection, { floating = false, over = {} }: { floating?: boolean; over?: Partial<CellDataSource> } = {}) {
  calls = { edits: [], saves: 0, widths: [], closes: [] };
  view = await mount(<Harness initial={sel} floating={floating} over={over} />);
}
const reselect = (sel: GridSelection) => act(async () => { select(sel); });

const aside = () => document.querySelector<HTMLElement>("[data-cell-data-view]")!;
const formatBox = () => aside().querySelector("select")!;
const message = () => aside().querySelector('[role="status"]')?.textContent ?? null;
const textBox = () => aside().querySelector("textarea")!;
const tree = () => aside().querySelector('[role="tree"]');
async function chooseFormat(id: string) {
  const box = formatBox();
  await act(async () => {
    box.value = id;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const setText = (el: HTMLTextAreaElement | HTMLInputElement, text: string) => act(async () => {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const blur = (el: Element) => act(async () => { el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
const key = (el: Element, k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => act(async () => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
});
/** The Form's fields, as name → what the value shows. */
const fields = () => Object.fromEntries([...aside().querySelectorAll<HTMLElement>(".border-b.px-2\\.5.pt-1\\.5")].map((f) => [
  f.querySelector("span.truncate")!.textContent,
  f.querySelector(".pl-\\[19px\\]")!.textContent,
]));
const button = (label: string) => aside().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("the format Autodetect picks", () => {
  it("names its pick in the Format box, and lists DBGate's formats after it", async () => {
    await open(cells(col("prefs"), 0));
    expect([...formatBox().options].map((o) => o.textContent)).toEqual([
      "Autodetect - Json", "Text (wrap)", "Text (no wrap)", "Form", "Json", "Json - expanded", "Json - Row", "Picture", "HTML", "XML",
    ]);
    // The outermost object open, its keys and values drawn.
    expect(tree()!.textContent).toContain("theme");
    expect(tree()!.textContent).toContain('"dark"');
    expect(tree()!.textContent).toContain("…] 2 items");
  });

  it("shows a whole row as a Form, a JSON text as Json, an image's bytes as a Picture, markup as XML, the rest as text", async () => {
    await open(wholeRows(0));
    expect(formatBox().options[0]!.textContent).toBe("Autodetect - Form");
    await reselect(cells(col("note"), 1));
    expect(formatBox().options[0]!.textContent).toBe("Autodetect - Json");
    expect(tree()!.textContent).toContain("x");
    await reselect(cells(col("photo"), 0));
    expect(formatBox().options[0]!.textContent).toBe("Autodetect - Picture");
    expect(aside().querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    await reselect(cells(col("note"), 2));
    expect(formatBox().options[0]!.textContent).toBe("Autodetect - XML");
    expect(aside().querySelector("pre")!.textContent).toBe("<p>hi</p>");
    await reselect(cells(col("name"), 0));
    expect(formatBox().options[0]!.textContent).toBe("Autodetect - Text (wrap)");
  });

  it("follows the selection while Autodetect is chosen, and keeps a format chosen by hand", async () => {
    await open(cells(col("prefs"), 0));
    await chooseFormat("text");
    await reselect(wholeRows(1));
    expect(formatBox().value).toBe("text");
    // The row's values in the grid's order, a NULL as nothing and the bytes in hex.
    expect(textBox().value.startsWith("2\nBo\n3\n\n89 50 4E 47 0D 0A 1A 0A 00 00 00 0D\n")).toBe(true);
    expect(textBox().value.endsWith('\n{"x": 1}')).toBe(true);
  });
});

describe("what DBGate says instead of a value", () => {
  it("asks for one cell when a single-cell format has several, and says when nothing is selected", async () => {
    await open(cells(col("name"), 0, 1, 3));
    await chooseFormat("json");
    expect(message()).toBe("Must be selected one cell");
    await chooseFormat("picture");
    expect(message()).toBe("Must be selected one cell");
    // Several cells are text, one under another.
    await chooseFormat("textWrap");
    expect(message()).toBeNull();
    expect(textBox().value).toBe("Ann\nBo\nCy");
    expect(textBox().readOnly).toBe(true);
    await reselect({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    expect(message()).toBe("No data selected");
  });

  it("says a value is no JSON, and draws no picture from what is not one", async () => {
    await open(cells(col("name"), 0));
    await chooseFormat("json");
    expect(message()).toBe("Error parsing JSON");
    await chooseFormat("picture");
    expect(message()).toBe("Error showing picture");
  });

  it("says a picture may be cut short when only its first bytes came with the row", async () => {
    await open(cells(col("photo"), 1));
    expect(aside().textContent).toContain("Only the first 12 bytes of 87.9 KB came with the row: the picture may be cut short.");
    await reselect(cells(col("photo"), 0));
    expect(aside().textContent).not.toContain("Only the first");
  });
});

describe("the other formats", () => {
  it("opens every object and list for Json - expanded, and the outermost alone for Json", async () => {
    await open(cells(col("prefs"), 0));
    expect(tree()!.textContent).not.toContain('"a"');
    await chooseFormat("jsonExpanded");
    expect(tree()!.textContent).toContain('"a"');
    expect(tree()!.textContent).toContain('"b"');
  });

  it("shows the whole row for Json - Row, and every row selected as a list", async () => {
    await open(cells(col("name"), 1));
    await chooseFormat("jsonRow");
    expect(tree()!.textContent).toContain("note");
    expect(tree()!.textContent).toContain('"Bo"');
    await reselect(cells(col("name"), 0, 1, 2));
    // Two rows: a list of two objects, the second folded.
    expect(tree()!.textContent).toMatch(/^\[0: \{/);
    expect(tree()!.textContent).toContain("1: {…} 6 keys");
  });

  it("draws HTML in a frame that runs nothing and loads nothing", async () => {
    await open(cells(col("note"), 2));
    await chooseFormat("html");
    const frame = aside().querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">`);
    expect(doc.endsWith("<p>hi</p>")).toBe(true);
  });

  it("does not wrap the text for Text (no wrap)", async () => {
    await open(cells(col("name"), 0, 1, 2));
    await chooseFormat("text");
    expect(textBox().getAttribute("wrap")).toBe("off");
    await chooseFormat("textWrap");
    expect(textBox().getAttribute("wrap")).toBe("soft");
  });
});

describe("typing a value", () => {
  it("puts what is typed in one cell into the change set once the box is left", async () => {
    await open(cells(col("name"), 0));
    expect(textBox().getAttribute("aria-label")).toBe("Edit name");
    await setText(textBox(), "Annie");
    expect(calls.edits).toEqual([]);
    await blur(textBox());
    expect(calls.edits).toEqual([[{ row: ROWS[0]!, column: "name", value: "Annie" }]]);
  });

  it("reads a number column's text as a number, and keeps nothing that is not one", async () => {
    await open(cells(col("qty"), 0));
    await setText(textBox(), "12");
    await blur(textBox());
    await setText(textBox(), "twelve");
    expect(textBox().getAttribute("aria-invalid")).toBe("true");
    expect(aside().textContent).toContain("Not a number");
    await blur(textBox());
    expect(calls.edits).toEqual([[{ row: ROWS[0]!, column: "qty", value: 12 }]]);
  });

  it("drops what was typed with Esc, and saves it with Ctrl+S", async () => {
    await open(cells(col("name"), 0));
    await setText(textBox(), "Annie");
    await key(textBox(), "Escape");
    expect(textBox().value).toBe("Ann");
    await blur(textBox());
    expect(calls.edits).toEqual([]);
    await setText(textBox(), "Anna");
    await key(textBox(), "s", { ctrlKey: true });
    expect(calls.edits).toEqual([[{ row: ROWS[0]!, column: "name", value: "Anna" }]]);
    expect(calls.saves).toBe(1);
  });

  it("puts what was typed in the cell it was typed for when another is selected", async () => {
    await open(cells(col("name"), 0));
    await setText(textBox(), "Annie");
    await reselect(cells(col("name"), 1));
    expect(calls.edits).toEqual([[{ row: ROWS[0]!, column: "name", value: "Annie" }]]);
    expect(textBox().value).toBe("Bo");
  });

  it("keeps a cell that cannot change read only, and several cells too", async () => {
    await open(cells(col("id"), 0));
    expect(textBox().readOnly).toBe(true);
    await reselect(cells(col("name"), 0, 1, 2));
    expect(textBox().readOnly).toBe(true);
    // A NULL shows as nothing, and is typed into from nothing.
    await reselect(cells(col("note"), 0));
    await chooseFormat("textWrap");
    expect([textBox().value, textBox().placeholder, textBox().readOnly]).toEqual(["", "(NULL)", false]);
  });

  it("marks itself a cell editor, which the table's keys leave alone", async () => {
    await open(cells(col("name"), 0));
    expect(textBox().hasAttribute("data-cell-editor")).toBe(true);
    await reselect(cells(col("id"), 0));
    expect(textBox().hasAttribute("data-cell-editor")).toBe(false);
  });
});

describe("the Form format", () => {
  it("lists the grid's columns with what each holds, NOT NULL names in bold", async () => {
    await open(wholeRows(0));
    expect(fields()).toEqual({ id: "1", name: "Ann", qty: "3", prefs: expect.stringContaining("theme"), photo: "12 bytes · 89 50 4E 47 0D 0A 1A 0A…", note: "(NULL)" });
    const bold = [...aside().querySelectorAll("span.font-semibold")].map((s) => s.textContent);
    expect(bold).toEqual(["id", "name"]);
  });

  it("reads (Multiple values) where the rows selected disagree, and the value where they agree", async () => {
    await open(wholeRows(0, 1));
    expect(fields().qty).toBe("3");
    expect(fields().name).toBe("(Multiple values)");
  });

  it("narrows the fields to Filter columns, and leaves out the empty ones with Hide NULL values, which this device keeps", async () => {
    await open(wholeRows(0));
    await setText(aside().querySelector<HTMLInputElement>('input[aria-label="Filter columns"]')!, "na");
    expect(Object.keys(fields())).toEqual(["name"]);
    await setText(aside().querySelector<HTMLInputElement>('input[aria-label="Filter columns"]')!, "");
    await click(aside().querySelector('input[type="checkbox"]'));
    expect(Object.keys(fields())).toEqual(["id", "name", "qty", "prefs", "photo"]);
    expect(localStorage.getItem("ppm-db-cell-data-hide-null")).toBe("1");
  });

  it("edits a field in place, in every row selected, with DBGate's keys", async () => {
    await open(wholeRows(0, 1));
    await click(button("Edit qty"));
    const input = aside().querySelector<HTMLInputElement>('input[aria-label="Edit qty"]')!;
    expect(document.activeElement).toBe(input);
    await setText(input, "7");
    await key(input, "Enter");
    expect(calls.edits).toEqual([[{ row: ROWS[0]!, column: "qty", value: 7 }, { row: ROWS[1]!, column: "qty", value: 7 }]]);
    // Ctrl+0: NULL, in both.
    await click(button("Edit note"));
    await key(aside().querySelector('input[aria-label="Edit note"]')!, "0", { ctrlKey: true });
    expect(calls.edits[1]).toEqual([{ row: ROWS[0]!, column: "note", value: null }, { row: ROWS[1]!, column: "note", value: null }]);
  });

  it("opens the editor of the next field with Tab and of the one before with Shift+Tab, Esc leaving the value as it was", async () => {
    await open(wholeRows(2));
    await click(button("Edit name"));
    await key(aside().querySelector('input[aria-label="Edit name"]')!, "Tab");
    const qty = aside().querySelector<HTMLInputElement>('input[aria-label="Edit qty"]')!;
    expect(document.activeElement).toBe(qty);
    await key(qty, "Tab", { shiftKey: true });
    const name = aside().querySelector<HTMLInputElement>('input[aria-label="Edit name"]')!;
    await setText(name, "Cyd");
    await key(name, "Escape");
    expect(aside().querySelector('input[aria-label="Edit name"]')).toBeNull();
    expect(calls.edits).toEqual([]);
  });

  it("offers no editor on a field that cannot change", async () => {
    await open(wholeRows(0));
    expect(button("Edit id")).toBeNull();
    expect(button("Edit photo")).toBeNull();
    expect(button("Edit name")).not.toBeNull();
  });
});

describe("its place beside the grid", () => {
  const edge = () => document.querySelector<HTMLElement>('[role="separator"]');

  it("widens with ← and narrows with →, from 220 to 560px", async () => {
    await open(cells(0, 0));
    expect(edge()!.getAttribute("aria-valuenow")).toBe("300");
    await key(edge()!, "ArrowLeft");
    await key(edge()!, "ArrowRight");
    await key(edge()!, "ArrowRight");
    await key(edge()!, "Home");
    await key(edge()!, "End");
    expect(calls.widths).toEqual([316, 300, 284, 220, 560]);
    expect(aside().style.width).toBe("560px");
  });

  it("follows a drag of its edge to the left, and is told the width once the drag ends", async () => {
    await open(cells(0, 0));
    const at = (type: string, clientX: number) => act(async () => {
      edge()!.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX, pointerId: 1 }));
    });
    await at("pointerdown", 500);
    await at("pointermove", 400);
    expect(edge()!.getAttribute("aria-valuenow")).toBe("400");
    expect(calls.widths).toEqual([]);
    await at("pointermove", 0);
    expect(edge()!.getAttribute("aria-valuenow")).toBe("560");
    await at("pointerup", 450);
    expect(calls.widths).toEqual([350]);
  });

  it("floats with no edge in a narrow tab, and goes with Esc, saying whether it held the focus", async () => {
    await open(cells(col("name"), 0), { floating: true });
    expect(edge()).toBeNull();
    // Over the grid's right edge, at most 86% of the tab wide (happy-dom drops a `min()` width, so only the place is asserted).
    expect(aside().className).toContain("absolute inset-y-0 right-0");
    await key(aside(), "Escape");
    textBox().focus();
    await click(button("Close the cell data view"));
    expect(calls.closes).toEqual([false, true]);
  });

  it("stays docked on Esc, which is the grid's", async () => {
    await open(cells(0, 0));
    await key(aside(), "Escape");
    expect(calls.closes).toEqual([]);
  });

  it("keeps the width this device last gave it, within its bounds", () => {
    expect(readCellDataWidth()).toBe(300);
    keepCellDataWidth(410);
    expect(readCellDataWidth()).toBe(410);
    localStorage.setItem("ppm-db-cell-data-width", "9000");
    expect(readCellDataWidth()).toBe(560);
    localStorage.setItem("ppm-db-cell-data-width", "nonsense");
    expect(readCellDataWidth()).toBe(300);
    expect([clampCellDataWidth(100), clampCellDataWidth(Number.NaN), clampCellDataWidth(333.6)]).toEqual([220, 300, 334]);
  });
});

describe("a phone's sheet", () => {
  it("names the format under its title, and closes with Done or ✕", async () => {
    calls = { edits: [], saves: 0, widths: [], closes: [] };
    let closed = 0;
    view = await mount(<CellDataSheet source={source(cells(col("prefs"), 0), {})} onClose={() => { closed += 1; }} />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Cell data view" + "Format: Autodetect - Json");
    expect(dialog.querySelector('[role="tree"]')).not.toBeNull();
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Done")!);
    await click(dialog.querySelector('button[aria-label="Close"]'));
    expect(closed).toBe(2);
  });

  it("keeps its keys from the grid under it", async () => {
    calls = { edits: [], saves: 0, widths: [], closes: [] };
    let reached = 0;
    view = await mount(
      <div onKeyDown={() => { reached += 1; }}>
        <CellDataSheet source={source(cells(col("name"), 0), {})} onClose={() => {}} />
      </div>,
    );
    const box = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    await key(box, "z", { ctrlKey: true });
    expect(reached).toBe(0);
  });
});
