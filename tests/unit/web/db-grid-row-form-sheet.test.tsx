/**
 * A phone's row form: one field per column the grid shows, what each holds now, what an edited one
 * was, the fields that cannot change closed, and what is typed put in once the field is left —
 * NULL when emptied, a number where the column holds numbers, nothing at all while it is not one.
 * Previous and Next walk the rows; Save says how many rows it would write.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useRef, useState } = await import("react");
const { RowFormSheet } = await import("../../../src/web/components/database/grid/row-form-sheet.tsx");
const { EMPTY_CHANGESET, addRows, changedRowCount, deleteRows, editCells } = await import("../../../src/web/components/database/grid/grid-changeset.ts");
type RowFormSheetProps = import("../../../src/web/components/database/grid/row-form-sheet.tsx").RowFormSheetProps;
type CellChange = import("../../../src/web/components/database/grid/grid-changeset.ts").CellChange;

const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: "nextval('t_id_seq'::regclass)" },
  { name: "name", type: "text", nullable: false, pk: false },
  { name: "qty", type: "integer", nullable: true, pk: false },
  { name: "active", type: "boolean", nullable: true, pk: false },
  { name: "photo", type: "bytea", nullable: true, pk: false },
  { name: "meta", type: "jsonb", nullable: true, pk: false },
];
const ROWS: Record<string, unknown>[] = [
  { id: 1, name: "Ann", qty: 3, active: true, photo: null, meta: { a: 1 } },
  { id: 2, name: "Bo", qty: null, active: null, photo: { $binary: "AAEC", size: 3 } },
  { id: "__new_1" },
];

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

async function sheet(over: Partial<RowFormSheetProps> = {}) {
  const edits: CellChange[][] = [];
  const moves: number[] = [];
  let saved = 0;
  let closed = 0;
  const props: RowFormSheetProps = {
    table: "users", rows: ROWS, loaded: 2, index: 0, onIndexChange: (i) => moves.push(i),
    columns: ["id", "name", "qty", "active", "photo", "meta"], schema: new Map(SCHEMA.map((c) => [c.name, c])),
    pkCol: "id", keyCols: ["id"], changeset: EMPTY_CHANGESET,
    // As the grid decides: a saved row's key and a row to be deleted are closed.
    canEdit: (row, column) => !(column === "id" && typeof row.id === "number"),
    onEdit: (c) => edits.push(c), pending: 0, onSave: () => { saved += 1; }, onClose: () => { closed += 1; },
    ...over,
  };
  view = await mount(<RowFormSheet {...props} />);
  return { edits, moves, saved: () => saved, closed: () => closed };
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
const field = (column: string) => {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.querySelector("span span")?.textContent === column)!;
  return document.getElementById(label.htmlFor) as HTMLInputElement & HTMLSelectElement;
};
const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** Typing into a field, then leaving it — or not: on iOS a tap on a button leaves it focused. */
async function type(column: string, text: string, leave: "blur" | "Enter" | "stay" = "blur") {
  const input = field(column);
  await act(async () => {
    // Still being typed in: the field has the focus, which is what Save takes from it.
    if (leave === "stay") input.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (leave === "stay") return;
  await act(async () => {
    if (leave === "blur") input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
async function choose(column: string, value: string) {
  const select = field(column);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("what the form shows", () => {
  it("names the table and the row by its key, and where it is among the rows", async () => {
    await sheet();
    expect(dialog().querySelector("h2")!.textContent).toBe("users · id = 1Row 1 / 2");
    expect(["id", "name", "qty", "active"].map((c) => field(c).value)).toEqual(["1", "Ann", "3", "true"]);
  });

  it("is titled Row where neither a table nor a key names it", async () => {
    await sheet({ table: null, keyCols: [], pkCol: null, canEdit: () => false });
    expect(dialog().querySelector("h2")!.textContent).toBe("RowRow 1 / 2");
    expect(field("name").value).toBe("Ann");
  });

  it("shows NULL as an empty field saying (NULL), and bytes as their size, closed", async () => {
    await sheet({ index: 1 });
    expect(field("qty").value).toBe("");
    expect(field("qty").placeholder).toBe("(NULL)");
    expect(field("active").value).toBe("");
    expect([...field("active").options].map((o) => o.textContent)).toEqual(["(NULL)", "true", "false"]);
    expect(field("photo").value).toContain("3 bytes");
    expect(field("photo").readOnly).toBe(true);
  });

  it("closes the fields the grid would not change: a saved row's key, every field of a row to be deleted", async () => {
    await sheet();
    expect(field("id").readOnly).toBe(true);
    expect(field("name").readOnly).toBe(false);
    await view!.unmount();
    const changeset = deleteRows(EMPTY_CHANGESET, [ROWS[0]!], "id", ["id"]);
    await sheet({ changeset, canEdit: () => false });
    expect(dialog().querySelector("h2 small")!.textContent).toBe("Row 1 / 2 · will be deleted");
    expect(field("name").readOnly).toBe(true);
    expect(field("active").disabled).toBe(true);
  });

  it("shows an edited field's new value and what it was", async () => {
    const changeset = editCells(EMPTY_CHANGESET, [{ row: ROWS[0]!, column: "name", value: "Anna" }, { row: ROWS[0]!, column: "qty", value: null }], "id", ["id"]);
    await sheet({ changeset });
    expect(field("name").value).toBe("Anna");
    const was = [...dialog().querySelectorAll("small")].map((s) => s.textContent).filter((t) => t?.startsWith("Was:"));
    expect(was).toEqual(["Was: Ann", "Was: 3"]);
  });

  it("shows a new row's fields as (No Field) until something is put in them", async () => {
    const changeset = editCells(addRows(EMPTY_CHANGESET, [{ id: "__new_1" }]), [{ row: ROWS[2]!, column: "name", value: "Dee" }], "id", ["id"]);
    await sheet({ index: 2, changeset, canEdit: (_row, column) => column !== "id" });
    expect(dialog().querySelector("h2")!.textContent).toBe("users · New rowNew row · not saved yet");
    expect(field("name").value).toBe("Dee");
    expect([field("id").value, field("id").placeholder]).toEqual(["", "(No Field)"]);
    expect(field("qty").placeholder).toBe("(No Field)");
    expect(field("active").value).toBe("");
    expect([...field("active").options].map((o) => [o.textContent, o.disabled])).toEqual([["(No Field)", true], ["true", false], ["false", false]]);
    // A new row's fields are its own: nothing to say what they were.
    expect(dialog().textContent).not.toContain("Was:");
  });
});

describe("changing a field", () => {
  it("puts what was typed in once the field is left, or on Enter: one change each", async () => {
    const { edits } = await sheet();
    await type("name", "Anna");
    await type("qty", "12", "Enter");
    expect(edits).toEqual([
      [{ row: ROWS[0], column: "name", value: "Anna" }],
      [{ row: ROWS[0], column: "qty", value: 12 }],
    ]);
  });

  it("puts NULL in a field emptied, and nothing when the field is left as it was", async () => {
    const { edits } = await sheet();
    await type("name", "Ann");
    // The same value written another way, and a JSON value shown as its text: neither is a change.
    await type("qty", "3.0");
    await type("meta", field("meta").value);
    expect(edits).toEqual([]);
    await type("qty", "");
    expect(edits).toEqual([[{ row: ROWS[0], column: "qty", value: null }]]);
  });

  it("does not put a number column anything that is not a number, and says so", async () => {
    const { edits } = await sheet();
    await type("qty", "12abc");
    await type("qty", "   ");
    expect(edits).toEqual([]);
    expect(field("qty").getAttribute("aria-invalid")).toBe("true");
    expect(dialog().textContent).toContain("Not a number");
    await type("qty", " 4.5 ");
    expect(edits).toEqual([[{ row: ROWS[0], column: "qty", value: 4.5 }]]);
  });

  it("sets a boolean from its list, NULL included where the column takes it", async () => {
    const { edits } = await sheet();
    await choose("active", "false");
    await choose("active", "");
    expect(edits).toEqual([[{ row: ROWS[0], column: "active", value: false }], [{ row: ROWS[0], column: "active", value: null }]]);
  });

  it("shows what the cell holds now when it changes under the open form: an undo", async () => {
    let undo!: () => void;
    function Open() {
      const [changeset, setChangeset] = useState(() => editCells(EMPTY_CHANGESET, [{ row: ROWS[0]!, column: "name", value: "Anna" }], "id", ["id"]));
      undo = () => setChangeset(EMPTY_CHANGESET);
      return (
        <RowFormSheet
          rows={ROWS} loaded={2} index={0} onIndexChange={() => {}} columns={["id", "name"]} schema={new Map(SCHEMA.map((c) => [c.name, c]))}
          pkCol="id" keyCols={["id"]} changeset={changeset} canEdit={() => true} onEdit={() => {}} pending={1} onClose={() => {}}
        />
      );
    }
    view = await mount(<Open />);
    expect(field("name").value).toBe("Anna");
    await act(async () => { undo(); });
    expect(field("name").value).toBe("Ann");
  });
});

describe("moving to another row", () => {
  it("starts that row's fields afresh: what was typed and not put in stays behind", async () => {
    let next!: () => void;
    function Walk() {
      const [index, setIndex] = useState(1);
      next = () => setIndex(2);
      return (
        <RowFormSheet
          rows={ROWS} loaded={2} index={index} onIndexChange={() => {}} columns={["id", "qty"]} schema={new Map(SCHEMA.map((c) => [c.name, c]))}
          pkCol="id" keyCols={["id"]} changeset={EMPTY_CHANGESET} canEdit={() => true} onEdit={() => {}} pending={0} onClose={() => {}}
        />
      );
    }
    view = await mount(<Walk />);
    // Row 2's qty is NULL and the new row's is not set: both show an empty field.
    await type("qty", "12abc");
    expect(dialog().textContent).toContain("Not a number");
    await act(async () => { next(); });
    expect(field("qty").value).toBe("");
    expect(dialog().textContent).not.toContain("Not a number");
  });
});

describe("the sheet's foot", () => {
  it("walks the rows, and stops at either end", async () => {
    const first = await sheet();
    expect(button("Previous row")!.disabled).toBe(true);
    await click(button("Next row"));
    expect(first.moves).toEqual([1]);
    await view!.unmount();
    const last = await sheet({ index: 2, canEdit: () => true });
    expect(button("Next row")!.disabled).toBe(true);
    await click(button("Previous row"));
    expect(last.moves).toEqual([1]);
  });

  it("saves with the count of rows it would write, and has nothing to save at none", async () => {
    const quiet = await sheet();
    expect(button("Save")!.disabled).toBe(true);
    await view!.unmount();
    const busy = await sheet({ pending: 2 });
    const save = button("Save 2 changed rows")!;
    expect(save.textContent).toBe("Save2");
    await click(save);
    expect(busy.saved()).toBe(1);
    expect(quiet.saved()).toBe(0);
    await click(button("Close"));
    expect(busy.closed()).toBe(1);
  });

  it("has no Save where the grid cannot save", async () => {
    await sheet({ onSave: undefined, pending: 1 });
    expect([...dialog().querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Close", "Previous row", "Next row"]);
  });
});

describe("a field still being typed in when a button is tapped", () => {
  it("is saved by Save, which waits for the change set it reads to hold it", async () => {
    // As the grid holds it: the change set in state, and Save reading the one last rendered.
    let atSave: unknown[] | null = null;
    function Grid() {
      const [changeset, setChangeset] = useState(EMPTY_CHANGESET);
      const rendered = useRef(changeset);
      rendered.current = changeset;
      return (
        <RowFormSheet
          rows={ROWS} loaded={2} index={0} onIndexChange={() => {}} columns={["id", "name"]} schema={new Map(SCHEMA.map((c) => [c.name, c]))}
          pkCol="id" keyCols={["id"]} changeset={changeset} canEdit={(_row, column) => column !== "id"}
          onEdit={(c) => setChangeset((cs) => editCells(cs, c, "id", ["id"]))} pending={changedRowCount(changeset)}
          onSave={() => { atSave = [...rendered.current.cells.values()].map((e) => e.newVal); }} onClose={() => {}}
        />
      );
    }
    view = await mount(<Grid />);
    await type("name", "Anna", "stay");
    expect(button("Save")!.disabled).toBe(false);
    await click(button("Save"));
    expect(atSave).toEqual(["Anna"]);
  });

  it("saves nothing, and leaves the sheet open, when that field was typed back to what it held", async () => {
    const { edits, saved } = await sheet();
    await type("qty", "3.0", "stay");
    await click(button("Save"));
    expect([edits, saved()]).toEqual([[], 0]);
  });

  it("does not save while that field does not read as its column's type", async () => {
    const { saved } = await sheet({ pending: 1 });
    await type("qty", "12abc", "stay");
    expect(button("Save 1 changed row")!.disabled).toBe(true);
    await type("qty", "12", "stay");
    await click(button("Save 1 changed row"));
    expect(saved()).toBe(1);
  });

  it("is put in when the sheet moves to another row or closes", async () => {
    const edits: CellChange[][] = [];
    function Walk() {
      const [index, setIndex] = useState(0);
      return (
        <RowFormSheet
          rows={ROWS} loaded={2} index={index} onIndexChange={setIndex} columns={["id", "name"]} schema={new Map(SCHEMA.map((c) => [c.name, c]))}
          pkCol="id" keyCols={["id"]} changeset={EMPTY_CHANGESET} canEdit={() => true} onEdit={(c) => edits.push(c)} pending={0} onClose={() => {}}
        />
      );
    }
    view = await mount(<Walk />);
    await type("name", "Anna", "stay");
    await click(button("Next row"));
    expect(edits).toEqual([[{ row: ROWS[0], column: "name", value: "Anna" }]]);
    expect(field("name").value).toBe("Bo");
    await type("name", "Bob", "stay");
    await view.unmount();
    view = null;
    expect(edits).toEqual([[{ row: ROWS[0], column: "name", value: "Anna" }], [{ row: ROWS[1], column: "name", value: "Bob" }]]);
  });
});
