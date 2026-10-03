/**
 * DBGate's marks for a change not saved yet: a row to be deleted washed red and struck through, a
 * new row washed green, an edited cell washed yellow with a bar at its left. The washes are the
 * row's theme; the strike and the bar are drawn over the cell Glide has drawn, through a canvas
 * context recorded here call by call.
 */
import { describe, expect, it } from "bun:test";
import { cellMark, drawCellMark, rowChange, rowChangeTheme } from "../../../src/web/components/database/grid/change-marks";
import { EMPTY_CHANGESET, addRows, deleteRows, editCells } from "../../../src/web/components/database/grid/grid-changeset";
import type { GridChangeColors } from "../../../src/web/components/database/glide-grid-theme";

const colors: GridChangeColors = {
  edited: "#edited", editedBar: "#bar", inserted: "#inserted", insertedMark: "#insmark",
  deleted: "#deleted", deletedText: "#deltext", deletedStrike: "#strike", deletedMark: "#delmark",
};

const saved = [{ id: 1, qty: 3 }, { id: 2, qty: 4 }];
// Row 1 edited, row 2 to be deleted, one new row with a value put in it.
const cs = deleteRows(
  editCells(addRows(EMPTY_CHANGESET, [{ id: "__new_1" }]), [
    { row: saved[0]!, column: "qty", value: 9 },
    { row: { id: "__new_1" }, column: "qty", value: 5 },
  ], "id", ["id"]),
  [saved[1]!], "id", ["id"],
);

describe("which rows are marked", () => {
  it("names a row to be deleted, a new row, and leaves an edited one to its cells", () => {
    expect(rowChange(cs, "2")).toBe("deleted");
    expect(rowChange(cs, "__new_1")).toBe("inserted");
    expect(rowChange(cs, "1")).toBeNull();
    expect(rowChange(EMPTY_CHANGESET, "1")).toBeNull();
  });

  it("washes the row and colours its number, and on a row to be deleted its text too", () => {
    expect(rowChangeTheme("deleted", colors)).toEqual({ bgCell: "#deleted", textDark: "#deltext", textLight: "#delmark" });
    expect(rowChangeTheme("inserted", colors)).toEqual({ bgCell: "#inserted", textLight: "#insmark" });
    expect(rowChangeTheme(null, colors)).toBeUndefined();
  });
});

describe("which cells are marked", () => {
  it("strikes every cell of a row to be deleted", () => {
    expect(cellMark(cs, "2", "id")).toBe("deleted");
    expect(cellMark(cs, "2", "qty")).toBe("deleted");
  });

  it("marks the edited cell of a saved row and no other", () => {
    expect(cellMark(cs, "1", "qty")).toBe("edited");
    expect(cellMark(cs, "1", "id")).toBeNull();
  });

  it("marks no cell of a new row, whose values are all its own", () => {
    expect(cellMark(cs, "__new_1", "qty")).toBeNull();
  });
});

/** A canvas context that writes down what was drawn, with the styles in force at the time. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    strokeStyle: "", fillStyle: "", lineWidth: 0,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x},${y}`),
    stroke() { calls.push(`stroke ${this.strokeStyle} ${this.lineWidth}`); },
    fillRect(x: number, y: number, w: number, h: number) { calls.push(`fillRect ${x},${y},${w},${h} ${this.fillStyle}`); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("drawing the marks", () => {
  const rect = { x: 10, y: 20, width: 100, height: 33 };

  it("strikes a row to be deleted from edge to edge, one crisp pixel through the middle", () => {
    const { ctx, calls } = recorder();
    drawCellMark(ctx, rect, "deleted", colors);
    // 20 + 33 / 2 = 36.5, on the pixel row 37: its middle is 37.5.
    expect(calls).toEqual(["save", "beginPath", "moveTo 10,37.5", "lineTo 110,37.5", "stroke #strike 1", "restore"]);
  });

  it("puts a bar the cell's height at the left of an edited cell", () => {
    const { ctx, calls } = recorder();
    drawCellMark(ctx, rect, "edited", colors);
    expect(calls).toEqual(["save", "fillRect 10,20,2,33 #bar", "restore"]);
  });

  it("draws nothing over a cell with no change", () => {
    const { ctx, calls } = recorder();
    drawCellMark(ctx, rect, null, colors);
    expect(calls).toEqual([]);
  });
});
