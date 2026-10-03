/**
 * The data grid's header is two bands on a desktop: the column titles, and under them DBGate's
 * filter row, which is HTML laid over the canvas (`grid-header-overlay.tsx`). Glide centres a
 * header's content in the whole header, so the titles are drawn here instead, in the top band and
 * clear of the right end, where the layer puts the column's menu button.
 *
 * A title is DBGate's: the key or link icon, the name — bold when the column is NOT NULL — its
 * type, and the sort. When the column is narrow the type gives way first, then the name; the menu
 * button keeps its room whatever the width. A sorted column shows an arrow instead of its type,
 * and its place in the sort only while several columns are sorted.
 */
import type { DrawHeaderCallback, Theme } from "@glideapps/glide-data-grid";
import { glyphPaths } from "@/lib/icons";
import type { SortDir } from "../../../../shared/db-grid";

/** Height of the band the column titles are drawn in. */
export const TITLE_BAND = 34;
/** The band on a phone, where a title is a 44 px touch target: a tap on it opens the column's sheet. */
export const TITLE_BAND_TOUCH = 44;
/** Height of the filter row under it. */
export const FILTER_BAND = 30;
/** Room kept free at a title's right end for the column menu button. */
export const MENU_BUTTON_ROOM = 24;

/** Glide's own width for its row marker column, which it widens as the row count grows. */
export function rowMarkerWidth(rows: number): number {
  return rows > 10000 ? 48 : rows > 1000 ? 44 : rows > 100 ? 36 : 32;
}

/** The sprites a title draws, by Glide `headerIcons` name: an auto-increment key, a key, a foreign key. */
export type TitleIcon = "headerAuto" | "headerKey" | "headerFk";

export interface TitleColumn {
  name: string;
  /** The full type, as the database spells it: `numeric(12,2)`. */
  type: string;
  notNull: boolean;
  icon: TitleIcon | null;
}

export interface TitleSort {
  dir: SortDir;
  /** The column's place in the sort, from 1; null while it is the only column sorted. */
  index: number | null;
}

export interface TitleFonts {
  name: string;
  /** The name of a NOT NULL column. */
  strongName: string;
  type: string;
  index: string;
}

/** Where a title's parts go, from the column's left edge, and the text each one keeps. */
export interface TitleLayout {
  iconX: number | null;
  nameX: number;
  name: string;
  typeX: number;
  /** Empty when there is no room for it, or the column is sorted. */
  type: string;
  arrowX: number | null;
  indexX: number | null;
  index: string;
}

const PAD = 8;
const ICON = 14;
const GAP = 5;
const ARROW = 10;
/** Less than this is not worth showing of a type: two letters and an ellipsis. */
const MIN_TYPE = 18;
const ELLIPSIS = "…";

type Measure = (text: string, font: string) => number;

/** `text` cut to `max` pixels, an ellipsis standing for what was cut; empty when not even that fits. */
export function fitText(text: string, max: number, font: string, measure: Measure): string {
  if (measure(text, font) <= max) return text;
  if (measure(ELLIPSIS, font) > max) return "";
  let lo = 0;
  let hi = text.length;
  // The longest start of the text that still fits with the ellipsis after it.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + ELLIPSIS, font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ELLIPSIS : text.slice(0, lo) + ELLIPSIS;
}

/** Lay a title out in a column `width` wide: the type gives way first, then the name. */
export function layoutTitle(col: TitleColumn, sort: TitleSort | null, width: number, fonts: TitleFonts, measure: Measure): TitleLayout {
  let x = PAD;
  const end = width - MENU_BUTTON_ROOM;
  const iconX = col.icon ? x : null;
  if (col.icon) x += ICON + GAP;
  const index = sort?.index != null ? String(sort.index) : "";
  const sortWidth = sort ? ARROW + (index ? 1 + measure(index, fonts.index) : 0) : 0;
  const nameFont = col.notNull ? fonts.strongName : fonts.name;
  // The sort mark stays whole; the name gets what is left of the width, the type what the name leaves.
  const room = Math.max(0, end - x - (sort ? GAP + sortWidth : 0));
  const name = fitText(col.name, room, nameFont, measure);
  const nameWidth = name ? measure(name, nameFont) : 0;
  const nameX = x;
  x += nameWidth;
  let type = "";
  let typeX = x;
  if (!sort && col.type && name === col.name) {
    const typeRoom = room - nameWidth - GAP;
    if (typeRoom >= MIN_TYPE) {
      type = fitText(col.type, typeRoom, fonts.type, measure);
      typeX = x + GAP;
    }
  }
  const arrowX = sort ? x + GAP : null;
  const indexX = sort && index ? arrowX! + ARROW + 1 : null;
  return { iconX, nameX, name, typeX, type, arrowX, indexX, index };
}

/** An arrow pointing up for ascending, down for descending, centred on `midY`. */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, midY: number, dir: SortDir, color: string) {
  const top = midY - 4.5;
  const bottom = midY + 4.5;
  const cx = x + ARROW / 2;
  const tip = dir === "ASC" ? top : bottom;
  const tail = dir === "ASC" ? bottom : top;
  const head = dir === "ASC" ? 3.5 : -3.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx, tail);
  ctx.lineTo(cx, tip);
  ctx.moveTo(cx - 3.5, tip + head);
  ctx.lineTo(cx, tip);
  ctx.lineTo(cx + 3.5, tip + head);
  ctx.stroke();
  ctx.restore();
}

/** The title fonts, in the grid's own family and the app's monospace one for types and sort places. */
export function titleFonts(family: string, mono: string): TitleFonts {
  return { name: `500 12px ${family}`, strongName: `700 12px ${family}`, type: `400 10px ${mono}`, index: `600 9.5px ${mono}` };
}

/**
 * Draws the column titles in the top `titleHeight` pixels. `columnAt` and `sortOf` are read on
 * every draw. The corner over the row numbers keeps Glide's select-all checkbox only when
 * `cornerCheckbox` says so: where the panel toggle is laid over the corner, it would be drawn under it.
 */
export function columnTitleDrawer(opts: {
  titleHeight: number;
  columnAt: (index: number) => TitleColumn | undefined;
  sortOf: (name: string) => TitleSort | null;
  /** The monospace family for types and sort places; the names are in the grid's own. */
  mono: string;
  cornerCheckbox?: boolean;
}): DrawHeaderCallback {
  const { titleHeight, columnAt, sortOf, mono, cornerCheckbox = false } = opts;
  let fonts: TitleFonts | null = null;
  let fontsFor = "";
  return ({ ctx, rect, columnIndex, theme, isSelected, spriteManager }, drawContent) => {
    if (columnIndex < 0) {
      if (cornerCheckbox) drawContent();
      return;
    }
    const col = columnAt(columnIndex);
    if (!col) return;
    if (!fonts || fontsFor !== theme.fontFamily) {
      fonts = titleFonts(theme.fontFamily, mono);
      fontsFor = theme.fontFamily;
    }
    const measure: Measure = (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    const sort = sortOf(col.name);
    const layout = layoutTitle(col, sort, rect.width, fonts, measure);
    const midY = rect.y + titleHeight / 2;
    // A selected column's title is drawn on the accent colour: everything on it takes the colour made for that.
    const ink = (color: string) => (isSelected ? theme.accentFg : color);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, Math.max(0, rect.width - MENU_BUTTON_ROOM), titleHeight);
    ctx.clip();
    ctx.textBaseline = "middle";
    if (col.icon && layout.iconX !== null) {
      const color = ink(theme.textHeader);
      const tinted: Theme = { ...theme, bgIconHeader: color, fgIconHeader: color };
      spriteManager.drawSprite(col.icon, "normal", ctx, rect.x + layout.iconX, midY - ICON / 2, ICON, tinted);
    }
    if (layout.name) {
      ctx.font = col.notNull ? fonts.strongName : fonts.name;
      ctx.fillStyle = ink(col.notNull ? theme.textDark : theme.textHeader);
      ctx.fillText(layout.name, rect.x + layout.nameX, midY);
    }
    if (layout.type) {
      ctx.font = fonts.type;
      ctx.fillStyle = ink(theme.textLight);
      ctx.fillText(layout.type, rect.x + layout.typeX, midY);
    }
    if (sort && layout.arrowX !== null) {
      drawArrow(ctx, rect.x + layout.arrowX, midY, sort.dir, ink(theme.accentColor));
      if (layout.indexX !== null) {
        ctx.font = fonts.index;
        ctx.fillStyle = ink(theme.accentColor);
        ctx.fillText(layout.index, rect.x + layout.indexX, midY + 1);
      }
    }
    ctx.restore();
  };
}

/** The icon a column's title carries: `#` for an auto-increment key, a key, a link for a foreign key. */
export function titleIcon(col: { pk: boolean; fk?: unknown; autoIncrement?: boolean }): TitleIcon | null {
  if (col.pk) return col.autoIncrement ? "headerAuto" : "headerKey";
  return col.fk ? "headerFk" : null;
}

const SPRITE_GLYPHS: Record<TitleIcon, string> = { headerAuto: "number-symbol", headerKey: "key", headerFk: "link" };

/** Glide `headerIcons` for the title icons: the app's own glyphs, in whatever colour a title draws them. */
export const TITLE_SPRITES = Object.fromEntries(
  Object.entries(SPRITE_GLYPHS).map(([sprite, glyph]) => {
    const d = (glyphPaths(glyph) ?? []).map((path) => `<path d="${path}"/>`).join("");
    return [sprite, (p: { fgColor: string }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="${p.fgColor}">${d}</svg>`];
  }),
) as Record<TitleIcon, (p: { fgColor: string }) => string>;
