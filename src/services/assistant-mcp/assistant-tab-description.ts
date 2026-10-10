import {
  READ_TAB_DB_CELL_CHARS, READ_TAB_DB_ROWS, READ_TAB_MAX_BYTES, READ_TAB_SQL_CHARS, type ShownRows, type TabDescription,
  type TextWindow,
} from "../../shared/assistant-tab-content.ts";
import { clip } from "./assistant-tool-output.ts";

/**
 * The device's `describe_tab` answer, checked field by field: only the shape
 * {@link TabDescription} names is kept, every string is bounded, and the parts the device
 * capped are capped again here, so a device that is not ours cannot widen what one read returns.
 */

const MAX_ID_CHARS = 400;
const MAX_PATH_CHARS = 4096;
const MAX_DETAIL_KEYS = 20;
const MAX_COLUMNS = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

function details(v: unknown): TabDescription["details"] {
  if (!isObj(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(v).slice(0, MAX_DETAIL_KEYS)) {
    if (key.length > 40) continue;
    if (typeof value === "string") out[key] = clip(value, 300);
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function textWindow(v: unknown): TextWindow | undefined {
  if (!isObj(v) || typeof v.text !== "string" || v.text.length > READ_TAB_MAX_BYTES) return undefined;
  const fromLine = count(v.fromLine);
  const toLine = count(v.toLine);
  const totalLines = count(v.totalLines);
  if (fromLine === undefined || toLine === undefined || totalLines === undefined) return undefined;
  const nextOffset = count(v.nextOffset);
  return { text: v.text, fromLine, toLine, totalLines, ...(nextOffset !== undefined ? { nextOffset } : {}) };
}

/** A database cell as JSON carries it, long values cut. */
function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clip(value, READ_TAB_DB_CELL_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    return clip(JSON.stringify(value), READ_TAB_DB_CELL_CHARS);
  } catch {
    return clip(String(value), READ_TAB_DB_CELL_CHARS);
  }
}

function shownRows(v: unknown): ShownRows | undefined {
  if (!isObj(v) || !Array.isArray(v.columns) || !Array.isArray(v.rows)) return undefined;
  const columns = v.columns.slice(0, MAX_COLUMNS).map((c) => clip(String(c), 200));
  const rows = v.rows.slice(0, READ_TAB_DB_ROWS).filter(Array.isArray).map((r) => (r as unknown[]).slice(0, MAX_COLUMNS).map(cell));
  return { columns, rows, more: v.more === true || v.rows.length > READ_TAB_DB_ROWS };
}

/** A database file a tab names: a bounded path, and the project it is relative to, if any. */
function dbFile(v: unknown): NonNullable<TabDescription["database"]>["file"] {
  if (!isObj(v)) return undefined;
  const path = str(v.path, MAX_PATH_CHARS);
  if (!path || path.includes("\0")) return undefined;
  const project = typeof v.project === "string" && v.project ? str(v.project, 200) : undefined;
  return { path, ...(project ? { project } : {}) };
}

export function parseTabDescription(raw: unknown): TabDescription | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, MAX_ID_CHARS);
  const type = str(raw.type, 40);
  if (!id || !type) return null;
  const area = raw.area === "dock" || raw.area === "window" ? raw.area : "grid";
  const desc: TabDescription = {
    id, type, area,
    title: clip(typeof raw.title === "string" ? raw.title : "", 200),
    project: typeof raw.project === "string" && raw.project ? clip(raw.project, 200) : null,
  };
  const d = details(raw.details);
  if (d) desc.details = d;
  if (isObj(raw.editor)) {
    const e = raw.editor;
    const unsaved = textWindow(e.unsaved);
    const filePath = str(e.filePath, MAX_PATH_CHARS);
    desc.editor = {
      untitled: e.untitled === true, special: e.special === true, dirty: e.dirty === true,
      ...(filePath ? { filePath } : {}), ...(unsaved ? { unsaved } : {}),
    };
  }
  if (isObj(raw.terminal)) {
    const sessionId = str(raw.terminal.sessionId, 100);
    desc.terminal = sessionId ? { sessionId } : {};
  }
  if (isObj(raw.database)) {
    const sql = typeof raw.database.sql === "string" ? clip(raw.database.sql, READ_TAB_SQL_CHARS) : undefined;
    const rows = shownRows(raw.database.rows);
    const id = raw.database.connectionId;
    const connectionId = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
    const file = connectionId === undefined ? dbFile(raw.database.file) : undefined;
    desc.database = {
      ...(connectionId !== undefined ? { connectionId } : file ? { file } : {}),
      ...(sql !== undefined ? { sql } : {}), ...(rows ? { rows } : {}),
    };
  }
  return desc;
}
