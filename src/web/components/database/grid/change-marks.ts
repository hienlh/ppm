/**
 * DBGate's marks for a pending change. A new row is washed green and a row to be deleted red, row
 * number included (the row's theme); an edited cell is washed yellow (the cell's theme). Over a
 * cell Glide has drawn, a row to be deleted is struck through from edge to edge and an edited cell
 * gets a bar at its left, as the mockup draws them.
 */
import type { Rectangle, Theme } from "@glideapps/glide-data-grid";
import type { GridChangeColors } from "../glide-grid-theme";
import { cellId, isNewRowId, type GridChangeset } from "./grid-changeset";

export type RowChange = "inserted" | "deleted" | null;

export function rowChange(cs: GridChangeset, rowId: string): RowChange {
  if (cs.deleted.has(rowId)) return "deleted";
  return isNewRowId(rowId) ? "inserted" : null;
}

/** The row's theme: its wash, and the colour its number and — on a row to be deleted — its text take. */
export function rowChangeTheme(change: RowChange, colors: GridChangeColors): Partial<Theme> | undefined {
  if (change === "deleted") return { bgCell: colors.deleted, textDark: colors.deletedText, textLight: colors.deletedMark };
  if (change === "inserted") return { bgCell: colors.inserted, textLight: colors.insertedMark };
  return undefined;
}

export type CellMark = "deleted" | "edited" | null;

/** What is drawn over a cell: a new row's cells are all its own values, so none of them reads as edited. */
export function cellMark(cs: GridChangeset, rowId: string, column: string): CellMark {
  const change = rowChange(cs, rowId);
  if (change === "deleted") return "deleted";
  return change === null && cs.cells.has(cellId(rowId, column)) ? "edited" : null;
}

export function drawCellMark(ctx: CanvasRenderingContext2D, rect: Rectangle, mark: CellMark, colors: GridChangeColors) {
  if (!mark) return;
  ctx.save();
  if (mark === "deleted") {
    // On the pixel grid, so the line is one crisp pixel rather than two faint ones.
    const y = Math.round(rect.y + rect.height / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.width, y);
    ctx.strokeStyle = colors.deletedStrike;
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillStyle = colors.editedBar;
    ctx.fillRect(rect.x, rect.y, 2, rect.height);
  }
  ctx.restore();
}
