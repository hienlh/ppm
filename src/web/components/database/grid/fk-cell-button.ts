/**
 * DBGate's form button in a foreign key cell, drawn on the grid's canvas: a 20px square at the
 * cell's right edge that opens the row the key refers to, as a form in a new tab. It is faint
 * until its cell is hovered or holds the cursor, and lit under the pointer — where the cursor
 * becomes a hand. A desktop's only: a phone's tap opens the row's own sheet.
 */
import type { Rectangle, Theme } from "@glideapps/glide-data-grid";
import { glyphPaths } from "@/lib/icons";

const SIZE = 20;
const INSET = 3;
const GLYPH = 14;
/** The cell's text stops this far from its right edge, as DBGate pads a cell holding the button. */
export const FK_BUTTON_ROOM = SIZE + INSET + 4;

/** Where the button sits in a cell, in the cell's own coordinates. */
function buttonBox(width: number, height: number) {
  return { x: width - INSET - SIZE, y: Math.round((height - SIZE) / 2) };
}

/** Whether a point in a cell — Glide's `localEventX`/`localEventY` — is on its button. */
export function isOnFkButton(x: number, y: number, cell: { width: number; height: number }): boolean {
  const box = buttonBox(cell.width, cell.height);
  return x >= box.x && x < box.x + SIZE && y >= box.y && y < box.y + SIZE;
}

export type FkButtonState = "faint" | "shown" | "hover";

/**
 * Draws the cell's own content beside the button: text running into it is cut off, and text set
 * against the right edge — a number — ends where the button begins, as DBGate's padding has it.
 */
export function drawBesideFkButton(
  ctx: CanvasRenderingContext2D, rect: Rectangle, align: { right: boolean; padding: number }, drawContent: () => void,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width - FK_BUTTON_ROOM, rect.height);
  ctx.clip();
  // Glide already leaves the cell's padding at the right edge; the rest of the room is the button's.
  if (align.right) ctx.translate(-(FK_BUTTON_ROOM - align.padding), 0);
  drawContent();
  ctx.restore();
}

let glyph: Path2D[] | null = null;

export function drawFkButton(ctx: CanvasRenderingContext2D, rect: Rectangle, state: FkButtonState, theme: Pick<Theme, "textLight" | "accentColor" | "accentLight">) {
  glyph ??= (glyphPaths("form") ?? []).map((d) => new Path2D(d));
  const box = buttonBox(rect.width, rect.height);
  const x = rect.x + box.x;
  const y = rect.y + box.y;
  ctx.save();
  if (state === "hover") {
    ctx.fillStyle = theme.accentLight;
    ctx.beginPath();
    ctx.roundRect(x, y, SIZE, SIZE, 4);
    ctx.fill();
  }
  ctx.globalAlpha = state === "faint" ? 0.35 : 1;
  ctx.fillStyle = state === "hover" ? theme.accentColor : theme.textLight;
  const offset = (SIZE - GLYPH) / 2;
  ctx.translate(x + offset, y + offset);
  ctx.scale(GLYPH / 20, GLYPH / 20);
  for (const path of glyph) ctx.fill(path);
  ctx.restore();
}
