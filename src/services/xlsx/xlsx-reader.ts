/**
 * Reads one sheet of an `.xlsx`/`.xlsm` for the read-only preview: the cells as the text Excel
 * would show for them, without a spreadsheet library. An `.xlsx` is a zip of XML parts, so it is
 * opened with `unzipit` (guarded like `unzip-vsix.ts`) and the parts are scanned with regular
 * expressions, a chunk at a time, yielding to the event loop between chunks.
 *
 * What it shows: shared/inline strings, numbers (15 significant digits, as Excel), booleans,
 * errors, dates (by the cell's number format, in UTC) and a formula's cached value. What it does
 * not: computing formulas, currency/percent formats, merged cells, colours.
 *
 * Parts are found through the package's relationships, never by guessing `sheetN.xml`: the sheet
 * order in the workbook need not follow the part names.
 */
import { posix } from "node:path";
import { unzip, type ZipEntry } from "unzipit";

/** Total of the uncompressed sizes the archive declares; unzipit stops inflating past a declared size. */
export const XLSX_MAX_UNCOMPRESSED = 200 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 5_000;
/** Columns shown; past it the rest are cut. */
export const XLSX_MAX_COLUMNS = 200;
/** Cells shown (a gap row counts as one); past it the sheet stops at the row before. */
export const XLSX_MAX_CELLS = 500_000;

const CHUNK_BYTES = 1024 * 1024;

export interface XlsxSheet {
  /** Every sheet's name, in workbook order. */
  sheets: string[];
  /** The index of the sheet in `rows`. */
  sheet: number;
  /** Row by row from row 1; `null` is an empty cell. A row may be shorter than `columns`. */
  rows: (string | null)[][];
  /** The widest row's length. */
  columns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

/** A workbook that cannot be shown, with what to tell the user. `status` is the HTTP answer. */
export class XlsxReadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 = 400) {
    super(message);
  }
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_MAGIC = [0x50, 0x4b];

const REL_OFFICE_DOCUMENT = "/officeDocument";
const REL_SHARED_STRINGS = "/sharedStrings";
const REL_STYLES = "/styles";

export async function readXlsxSheet(bytes: Uint8Array, sheetIndex = 0): Promise<XlsxSheet> {
  if (CFB_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new XlsxReadError("This workbook is password-protected or in the legacy .xls format.");
  }
  if (!ZIP_MAGIC.every((b, i) => bytes[i] === b)) throw new XlsxReadError("Not a valid .xlsx file.");

  let entries: Record<string, ZipEntry>;
  try {
    ({ entries } = await unzip(bytes));
  } catch {
    throw new XlsxReadError("Not a valid .xlsx file.");
  }
  const names = Object.keys(entries);
  if (names.length > XLSX_MAX_ENTRIES) throw new XlsxReadError("Workbook has too many parts.", 413);
  let declared = 0;
  for (const name of names) {
    declared += entries[name]!.size;
    if (declared > XLSX_MAX_UNCOMPRESSED) throw new XlsxReadError("Workbook too large to preview.", 413);
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const entry = (path: string): ZipEntry | undefined => {
    const name = entries[path] ? path : lower.get(path.toLowerCase());
    return name ? entries[name] : undefined;
  };
  const text = async (path: string): Promise<string | null> => {
    const e = entry(path);
    return e ? new TextDecoder().decode(await inflate(e)) : null;
  };

  const rootRels = parseRels(await text("_rels/.rels"), "");
  const workbookPath = rootRels.find((r) => r.type.endsWith(REL_OFFICE_DOCUMENT))?.target ?? "xl/workbook.xml";
  const workbookXml = await text(workbookPath);
  if (workbookXml == null) throw new XlsxReadError("Not a valid .xlsx file.");
  const wbRels = parseRels(await text(relsPathOf(workbookPath)), posix.dirname(workbookPath));
  const relTarget = new Map(wbRels.map((r) => [r.id, r.target]));

  const sheetList = [...workbookXml.matchAll(tagRe("sheet"))].map((m) => {
    const a = attrs(m[1]!);
    const rid = Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1];
    return { name: a.name ?? "", target: rid ? relTarget.get(rid) : undefined };
  });
  const sheets = sheetList.map((s) => s.name);
  const chosen = sheetList[sheetIndex];
  if (!chosen) throw new XlsxReadError("Sheet not found.", 404);

  const date1904 = /\bdate1904\s*=\s*["'](1|true)["']/.test(firstTag(workbookXml, "workbookPr") ?? "");
  const sstPath = wbRels.find((r) => r.type.endsWith(REL_SHARED_STRINGS))?.target;
  const stylesPath = wbRels.find((r) => r.type.endsWith(REL_STYLES))?.target;
  const shared = sstPath ? await readSharedStrings(entry(sstPath)) : [];
  const dateKinds = stylesPath ? parseDateStyles((await text(stylesPath)) ?? "") : [];

  const sheetEntry = chosen.target ? entry(chosen.target) : undefined;
  const result = sheetEntry
    ? await readRows(sheetEntry, shared, dateKinds, date1904)
    : { rows: [], columns: 0, truncatedRows: false, truncatedColumns: false };
  return { sheets, sheet: sheetIndex, ...result };
}

/** An entry's bytes. unzipit refuses one that inflates to more or less than it declares. */
async function inflate(e: ZipEntry): Promise<ArrayBuffer> {
  try {
    return await e.arrayBuffer();
  } catch {
    throw new XlsxReadError("This workbook is damaged.");
  }
}

// ── XML helpers ───────────────────────────────────────────────────────────

/** `<name …>…</name>` or `<name …/>`, with any namespace prefix; [1] attributes, [3] body. */
function tagRe(name: string): RegExp {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>)`, "g");
}

function firstTag(xml: string, name: string): string | undefined {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`).exec(xml)?.[1];
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decodeXml(m[2] ?? m[3] ?? "");
  }
  return out;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML entities, then OOXML's `_xHHHH_` escapes (`_x000D_` is a carriage return, `_x005F_` an underscore). */
export function decodeXml(s: string): string {
  const unescaped = s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, ref: string) => {
    if (ref[0] !== "#") return ENTITIES[ref] ?? all;
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
  return unescaped.indexOf("_x") < 0
    ? unescaped
    : unescaped.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The text of a `<si>` or `<is>`: its `<t>` runs, leaving out phonetic runs (`<rPh>`). */
function richText(body: string): string {
  const visible = body.replace(tagRe("rPh"), "");
  let out = "";
  for (const m of visible.matchAll(tagRe("t"))) out += m[3] ?? "";
  return decodeXml(out);
}

interface Rel { id: string; type: string; target: string }

function relsPathOf(part: string): string {
  return posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
}

/** Relationships with their targets made zip paths: relative to `baseDir`, or absolute from the root. */
function parseRels(xml: string | null, baseDir: string): Rel[] {
  if (!xml) return [];
  const out: Rel[] = [];
  for (const m of xml.matchAll(tagRe("Relationship"))) {
    const a = attrs(m[1]!);
    if (!a.Id || !a.Target || a.TargetMode === "External") continue;
    const raw = a.Target.replace(/\\/g, "/");
    const target = posix.normalize(raw.startsWith("/") ? raw.slice(1) : posix.join(baseDir, raw));
    if (target.startsWith("..")) continue;
    out.push({ id: a.Id, type: a.Type ?? "", target });
  }
  return out;
}

/**
 * Feeds a part's XML in ~1 MB pieces to `onChunk`, which takes every complete `</close>` element
 * and returns how much of the text it consumed. Yields to the event loop between pieces.
 */
async function scanPart(
  e: ZipEntry,
  close: string,
  onChunk: (xml: string) => number | "stop",
): Promise<void> {
  const bytes = new Uint8Array(await inflate(e));
  const decoder = new TextDecoder();
  const closeRe = new RegExp(`<\\/(?:[\\w.-]+:)?${close}>`, "g");
  let carry = "";
  for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, bytes.length);
    carry += decoder.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    // Cut after the last complete element so a tag split across pieces waits for the next one.
    let cut = 0;
    closeRe.lastIndex = 0;
    for (let m = closeRe.exec(carry); m; m = closeRe.exec(carry)) cut = m.index + m[0].length;
    if (end === bytes.length) cut = carry.length;
    if (cut > 0) {
      if (onChunk(carry.slice(0, cut)) === "stop") return;
      carry = carry.slice(cut);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function readSharedStrings(e: ZipEntry | undefined): Promise<string[]> {
  if (!e) return [];
  const out: string[] = [];
  await scanPart(e, "si", (xml) => {
    for (const m of xml.matchAll(tagRe("si"))) out.push(richText(m[3] ?? ""));
    return xml.length;
  });
  return out;
}

// ── Dates ─────────────────────────────────────────────────────────────────

/**
 * What a number format shows of a serial. `duration-*` is elapsed time in a bracketed unit
 * (`[h]`, `[m]`, `[s]`), a total that does not wrap at a day; the `s` suffix adds seconds.
 */
type DateKind = "date" | "time" | "datetime" | "duration-h" | "duration-hs" | "duration-m" | "duration-ms" | "duration-s" | null;

const BUILTIN_DATE_FORMATS: Record<number, DateKind> = {
  14: "date", 15: "date", 16: "date", 17: "date",
  18: "time", 19: "time", 20: "time", 21: "time",
  22: "datetime",
  45: "time", 46: "duration-hs", 47: "time",
};

/** What a custom number format shows of a date, or `null` when it is not a date format. */
export function dateKindOfFormat(code: string): DateKind {
  const unquoted = code.toLowerCase().replace(/"[^"]*"/g, "");
  // Elapsed time is told by its bracketed unit, which the stripping below would throw away.
  const elapsed = /\[(h+|m+|s+)\]/.exec(unquoted)?.[1]?.[0];
  const f = unquoted
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\\_*]./g, "")
    .replace(/am\/pm|a\/p/g, "");
  if (elapsed === "s") return "duration-s";
  if (elapsed === "h" || elapsed === "m") {
    const withSeconds = /s/.test(f);
    return elapsed === "h" ? (withSeconds ? "duration-hs" : "duration-h") : withSeconds ? "duration-ms" : "duration-m";
  }
  const hasDate = /[yd]/.test(f);
  const hasTime = /[hs]/.test(f);
  if (hasDate && hasTime) return "datetime";
  if (hasTime) return "time";
  if (hasDate || /m/.test(f)) return "date";
  return null;
}

/** The date kind of each cell style (`<c s="…">` indexes `cellXfs`). */
function parseDateStyles(xml: string): DateKind[] {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(tagRe("numFmt"))) {
    const a = attrs(m[1]!);
    if (a.numFmtId && a.formatCode != null) custom.set(Number(a.numFmtId), a.formatCode);
  }
  const xfs = new RegExp(`<(?:[\\w.-]+:)?cellXfs\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?cellXfs>`).exec(xml)?.[1] ?? "";
  return [...xfs.matchAll(tagRe("xf"))].map((m) => {
    const id = Number(attrs(m[1]!).numFmtId ?? 0);
    const code = custom.get(id);
    return code != null ? dateKindOfFormat(code) : BUILTIN_DATE_FORMATS[id] ?? null;
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** An Excel serial date as text, in UTC. */
export function formatSerialDate(serial: number, kind: Exclude<DateKind, null>, date1904: boolean): string {
  if (kind.startsWith("duration-")) return formatDuration(serial, kind);
  // 1900 system: serial 1 is 1900-01-01, and Excel counts a 1900-02-29 that never was (serial 60),
  // so from serial 61 on the day count starts at 1899-12-30.
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(base + Math.round(serial * 86400) * 1000);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (kind === "time") return time;
  return kind === "datetime" ? `${date} ${time}` : date;
}

/** Elapsed time: the bracketed unit is a total (1.5 days in `[h]:mm` is `36:00`), the rest wrap. */
function formatDuration(serial: number, kind: string): string {
  const total = Math.round(serial * 86400);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60);
  const s = total % 60;
  switch (kind) {
    case "duration-h": return `${h}:${pad(m % 60)}`;
    case "duration-hs": return `${h}:${pad(m % 60)}:${pad(s)}`;
    case "duration-m": return String(m);
    case "duration-ms": return `${m}:${pad(s)}`;
    default: return String(total);
  }
}

/** A number as Excel shows it in General: at most 15 significant digits. */
export function formatNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toPrecision(15)));
}

// ── Sheet ─────────────────────────────────────────────────────────────────

/** 0-based column of a cell reference's letters (`C5` → 2), or -1. */
export function columnIndex(ref: string): number {
  let n = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i) | 0x20; // lower-case
    if (c < 97 || c > 122) break;
    n = n * 26 + (c - 96);
  }
  return i === 0 ? -1 : n - 1;
}

function cellText(
  a: Record<string, string>,
  body: string,
  shared: string[],
  dateKinds: DateKind[],
  date1904: boolean,
): string | null {
  const t = a.t ?? "n";
  if (t === "inlineStr") {
    const is = tagRe("is").exec(body);
    return is ? richText(is[3] ?? "") : null;
  }
  const vm = tagRe("v").exec(body);
  if (!vm || vm[3] == null) return null;
  const v = vm[3];
  switch (t) {
    case "s": return shared[Number(v)] ?? null;
    case "b": return v.trim() === "1" ? "TRUE" : "FALSE";
    case "str": case "e": case "d": return decodeXml(v);
    default: {
      const kind = dateKinds[Number(a.s ?? 0)];
      const n = Number(v);
      if (kind && Number.isFinite(n) && n >= 0) return formatSerialDate(n, kind, date1904);
      return formatNumber(v.trim());
    }
  }
}

async function readRows(
  e: ZipEntry,
  shared: string[],
  dateKinds: DateKind[],
  date1904: boolean,
): Promise<Omit<XlsxSheet, "sheets" | "sheet">> {
  const rows: (string | null)[][] = [];
  let columns = 0;
  let cells = 0;
  let truncatedRows = false;
  let truncatedColumns = false;
  const rowRe = tagRe("row");
  const cellRe = tagRe("c");

  await scanPart(e, "row", (xml) => {
    for (const rm of xml.matchAll(rowRe)) {
      const ra = attrs(rm[1]!);
      const rowNo = ra.r ? Number(ra.r) - 1 : rows.length;
      if (!Number.isInteger(rowNo) || rowNo < rows.length) continue;
      const row: (string | null)[] = [];
      let col = -1;
      for (const cm of (rm[3] ?? "").matchAll(cellRe)) {
        const ca = attrs(cm[1]!);
        const at = ca.r ? columnIndex(ca.r) : -1;
        col = at >= 0 ? at : col + 1;
        const value = cellText(ca, cm[3] ?? "", shared, dateKinds, date1904);
        if (value == null) continue;
        if (col >= XLSX_MAX_COLUMNS) { truncatedColumns = true; continue; }
        while (row.length < col) row.push(null);
        row[col] = value;
      }
      const gap = rowNo - rows.length;
      if (cells + gap + Math.max(row.length, 1) > XLSX_MAX_CELLS) {
        truncatedRows = true;
        return "stop";
      }
      for (let i = 0; i < gap; i++) rows.push([]);
      rows.push(row);
      cells += gap + Math.max(row.length, 1);
      if (row.length > columns) columns = row.length;
    }
    return xml.length;
  });

  // Rows that only carry formatting after the last value are not worth a screen of blanks.
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return { rows, columns, truncatedRows, truncatedColumns };
}
