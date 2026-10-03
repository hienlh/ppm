/**
 * The cells the grid hands Glide, drawn from the change set: an edited cell of a saved row washed
 * yellow with its new value, a new row's cells holding only what was put in them — DBGate's
 * (No Field) elsewhere — and the cells that cannot be changed closed to editing. Glide's edits come
 * back through `onCellsEdited` as one step of the change set, however many cells they cover.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { GridCellKind } = await import("@glideapps/glide-data-grid");
const { useGlideCellContent } = await import("../../../src/web/components/database/use-glide-cell-content.ts");
const { EMPTY_CHANGESET, addRows, deleteRows, editCells } = await import("../../../src/web/components/database/grid/grid-changeset.ts");
type GridChangeColors = import("../../../src/web/components/database/glide-grid-theme.ts").GridChangeColors;
type CellChange = import("../../../src/web/components/database/grid/grid-changeset.ts").CellChange;
type EditListItem = import("@glideapps/glide-data-grid").EditListItem;

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const schema = [
  // A serial key, as Postgres describes one.
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: "nextval('t_id_seq'::regclass)", autoIncrement: true },
  { name: "qty", type: "integer", nullable: true, pk: false },
  { name: "note", type: "text", nullable: true, pk: false },
];
const columns = ["id", "qty", "note"];
const colors = { edited: "#edited" } as GridChangeColors;
const rows: Record<string, unknown>[] = [{ id: 1, qty: 3, note: "a" }, { id: 2, qty: 4, note: null }, { id: "__new_1" }];
// Row 1's qty edited, row 2 to be deleted, a note put in the new row.
const changeset = deleteRows(
  editCells(addRows(EMPTY_CHANGESET, [{ id: "__new_1" }]), [
    { row: rows[0]!, column: "qty", value: 9 },
    { row: rows[2]!, column: "note", value: "x" },
  ], "id", ["id"]),
  [rows[1]!], "id", ["id"],
);

async function cellContent({ readOnly = false, pkCol = "id" as string | null, cs = changeset, cols = schema } = {}) {
  const edits: CellChange[][] = [];
  const ref = {} as { hook: ReturnType<typeof useGlideCellContent> };
  function Harness() {
    ref.hook = useGlideCellContent(rows, columns, cols, pkCol, (c) => edits.push(c), { current: cs }, colors, readOnly);
    return null;
  }
  view = await mount(<Harness />);
  return { ...ref.hook, edits };
}

describe("a saved row", () => {
  it("shows an edited cell's new value, washed yellow, and leaves the others as read", async () => {
    const { getCellContent } = await cellContent();
    expect(getCellContent([1, 0])).toMatchObject({ kind: GridCellKind.Number, data: 9, displayData: "9", readonly: false, allowOverlay: true, themeOverride: { bgCell: "#edited" } });
    expect(getCellContent([2, 0])).toMatchObject({ displayData: "a", readonly: false });
    expect(getCellContent([2, 0]).themeOverride).toBeUndefined();
  });

  it("keeps an edited cell's wash when what was put in it is NULL", async () => {
    const { getCellContent } = await cellContent({ cs: editCells(EMPTY_CHANGESET, [{ row: rows[0]!, column: "note", value: null }], "id", ["id"]) });
    expect(getCellContent([2, 0])).toMatchObject({ displayData: "(NULL)", readonly: false, themeOverride: { bgCell: "#edited", baseFontStyle: "italic 12px" } });
  });

  it("keeps its key closed: the key is what finds the row", async () => {
    const { getCellContent } = await cellContent();
    expect(getCellContent([0, 0])).toMatchObject({ data: 1, readonly: true, allowOverlay: false });
  });

  it("closes every cell of a row to be deleted", async () => {
    const { getCellContent } = await cellContent();
    expect(getCellContent([1, 1])).toMatchObject({ data: 4, readonly: true });
    expect(getCellContent([2, 1])).toMatchObject({ displayData: "(NULL)", readonly: true, allowOverlay: false });
  });
});

describe("a new row", () => {
  it("holds only what was put in it, unwashed: the row's own green is its theme", async () => {
    const { getCellContent } = await cellContent();
    expect(getCellContent([2, 2])).toMatchObject({ displayData: "x", readonly: false });
    expect(getCellContent([2, 2]).themeOverride).toBeUndefined();
  });

  it("shows (No Field) where nothing was put, and edits a number column as a number", async () => {
    const { getCellContent } = await cellContent();
    const cell = getCellContent([1, 2]);
    expect(cell).toMatchObject({ kind: GridCellKind.Number, data: undefined, displayData: "(No Field)", readonly: false, allowOverlay: true });
    expect(cell.themeOverride?.bgCell).toBeUndefined();
  });

  it("leaves a key the database numbers to the database", async () => {
    const { getCellContent } = await cellContent();
    expect(getCellContent([0, 2])).toMatchObject({ displayData: "(No Field)", readonly: true, allowOverlay: false });
  });

  it("opens any other key to what is typed, an integer one included", async () => {
    // Postgres' `id integer PRIMARY KEY`: SQLite's rowid alias by its type, and nothing fills it in.
    const { getCellContent } = await cellContent({ cols: [{ ...schema[0]!, defaultValue: null, autoIncrement: false }, ...schema.slice(1)] });
    expect(getCellContent([0, 2])).toMatchObject({ displayData: "(No Field)", readonly: false, allowOverlay: true });
    // A saved row's key still finds the row.
    expect(getCellContent([0, 0])).toMatchObject({ readonly: true, allowOverlay: false });
  });
});

describe("a grid that cannot change rows", () => {
  it("closes every cell when it is read-only, or has no key to find a row by", async () => {
    for (const options of [{ readOnly: true }, { pkCol: null }]) {
      const { getCellContent } = await cellContent(options);
      expect(getCellContent([2, 0])).toMatchObject({ displayData: "a", readonly: true });
      expect(getCellContent([2, 2]).readonly).toBe(true);
      await view?.unmount();
      view = null;
    }
  });
});

describe("Glide's edits", () => {
  const text = (data: string) => ({ kind: GridCellKind.Text, data, displayData: data, allowOverlay: true }) as const;

  it("go into the change set in one step, a cleared cell as NULL", async () => {
    const { onCellsEdited, edits } = await cellContent();
    const handled = onCellsEdited([
      { location: [1, 0], value: { kind: GridCellKind.Number, data: 7, displayData: "7", allowOverlay: true } },
      { location: [2, 0], value: text("") },
      { location: [1, 2], value: { kind: GridCellKind.Number, data: undefined, displayData: "", allowOverlay: true } },
    ] as EditListItem[]);
    expect(handled).toBe(true);
    expect(edits).toEqual([[
      { row: rows[0]!, column: "qty", value: 7 },
      { row: rows[0]!, column: "note", value: null },
      { row: rows[2]!, column: "qty", value: null },
    ]]);
  });

  it("leave out a cell the grid does not edit, or one past the rows", async () => {
    const { onCellsEdited, edits } = await cellContent();
    onCellsEdited([
      { location: [2, 0], value: { kind: GridCellKind.Uri, data: "https://x", allowOverlay: true } },
      { location: [2, 9], value: text("lost") },
      { location: [2, 2], value: text("kept") },
    ] as EditListItem[]);
    expect(edits).toEqual([[{ row: rows[2]!, column: "note", value: "kept" }]]);
    // Nothing left of them, nothing goes in: not even an empty step.
    onCellsEdited([{ location: [2, 0], value: { kind: GridCellKind.Uri, data: "https://x", allowOverlay: true } }] as EditListItem[]);
    expect(edits.length).toBe(1);
  });

  it("change nothing in a read-only grid, and are still not handed back one by one", async () => {
    const { onCellsEdited, edits } = await cellContent({ readOnly: true });
    expect(onCellsEdited([{ location: [2, 0], value: text("b") }] as EditListItem[])).toBe(true);
    expect(edits).toEqual([]);
  });
});
