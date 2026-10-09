import { usePanelStore } from "@/stores/panel-store";
import { DOCK_PANEL_ID, isWindowPanelId } from "@/stores/panel-utils";
import type { Tab } from "@/stores/tab-store";
import {
  READ_TAB_DB_CELL_CHARS, READ_TAB_DB_ROWS, READ_TAB_SQL_CHARS, lineWindow, type ShownRows, type TabDescription,
} from "../../../shared/assistant-tab-content";
import { MAX_SNAPSHOT_TITLE_CHARS, tabDetails } from "./ui-state-snapshot";
import { readTabLiveContent, type TabLiveContent } from "./tab-live-content";
import { targetOf } from "@/lib/db-tabs";

/**
 * The device half of `ui_read_tab` (`describe_tab`): which tab it is, its allow-listed
 * metadata, and what only this browser holds — an editor's unsaved text, a Query tab's SQL,
 * the rows a database tab shows. Everything is capped here and again on the server. Nothing
 * of it goes into the per-message screen summary; it leaves the device only when asked.
 */

/** Characters the rows of one description may take, well inside what one device answer may carry. */
const MAX_ROWS_CHARS = 150_000;
const DB_TAB_TYPES = new Set(["database", "db-query"]);

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters cut]` : text);

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cut(value, READ_TAB_DB_CELL_CHARS);
  try {
    return cut(JSON.stringify(value), READ_TAB_DB_CELL_CHARS);
  } catch {
    return cut(String(value), READ_TAB_DB_CELL_CHARS);
  }
}

/** At most {@link READ_TAB_DB_ROWS} rows, each cell cut, the whole held under {@link MAX_ROWS_CHARS}. */
export function capShownRows(rows: ShownRows): ShownRows {
  let kept = rows.rows.slice(0, READ_TAB_DB_ROWS).map((r) => r.map(cell));
  let more = rows.more || rows.rows.length > kept.length;
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_ROWS_CHARS) {
    kept = kept.slice(0, Math.floor(kept.length * 0.8));
    more = true;
  }
  return { columns: rows.columns.map((c) => cut(String(c), 200)), rows: kept, more };
}

export interface DescribeTabInput {
  tab: Pick<Tab, "id" | "type" | "title" | "projectId" | "metadata">;
  area: TabDescription["area"];
  /** What the mounted tab published, when it is mounted. */
  live?: TabLiveContent;
  /** The shell a terminal tab is attached to. */
  terminalSessionId?: string | null;
  /** Where an unsaved text's window starts, in lines. */
  offset: number;
}

/** Pure: the description of one tab from what the stores and the mounted tab hold. */
export function describeTabFrom({ tab, area, live, terminalSessionId, offset }: DescribeTabInput): TabDescription {
  const meta = tab.metadata ?? {};
  const metaProject = meta.projectName;
  const details = tabDetails(tab);
  const desc: TabDescription = {
    id: tab.id,
    type: tab.type,
    title: cut(tab.title ?? "", MAX_SNAPSHOT_TITLE_CHARS),
    project: tab.projectId ?? (typeof metaProject === "string" && metaProject ? metaProject : null),
    area,
    ...(details ? { details } : {}),
  };
  if (tab.type === "editor") {
    const untitled = meta.isUntitled === true;
    const stored = typeof meta.unsavedContent === "string" ? meta.unsavedContent : "";
    const text = live?.kind === "editor" ? live.text : stored;
    const dirty = live?.kind === "editor" ? live.dirty : untitled && stored.length > 0;
    desc.editor = {
      untitled,
      special: Boolean(meta.viewerKey) || meta.inlineContent != null,
      dirty,
      ...(typeof meta.filePath === "string" && meta.filePath ? { filePath: meta.filePath } : {}),
      ...(dirty || untitled ? { unsaved: lineWindow(text, offset) } : {}),
    };
  } else if (tab.type === "terminal") {
    desc.terminal = terminalSessionId ? { sessionId: terminalSessionId } : {};
  } else if (DB_TAB_TYPES.has(tab.type)) {
    const sql = tab.type === "db-query" && typeof meta.currentSql === "string" ? cut(meta.currentSql, READ_TAB_SQL_CHARS) : undefined;
    const rows = live?.kind === "rows" && live.rows ? capShownRows(live.rows) : undefined;
    // The server reads the tab only for a saved connection the user made available to the AI,
    // so it needs to know which one; a database file opened by path names none.
    const target = targetOf(meta);
    const connectionId = target?.kind === "connection" ? target.connectionId : undefined;
    desc.database = {
      ...(connectionId !== undefined ? { connectionId } : {}), ...(sql !== undefined ? { sql } : {}), ...(rows ? { rows } : {}),
    };
  }
  return desc;
}

function terminalSession(tabId: string): string | null {
  try {
    return localStorage.getItem(`ppm:terminal-session:${tabId}`);
  } catch {
    return null;
  }
}

/** `describe_tab` on this device: the tab `args.tabId` names, wherever it is open. */
export function describeTab(args: Record<string, unknown>): TabDescription {
  const tabId = args.tabId;
  if (typeof tabId !== "string" || !tabId) throw new Error("`tabId` is required: an id from ui_get_state.");
  const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const panel = usePanelStore.getState().getPanelForTab(tabId);
  const tab = panel?.tabs.find((t) => t.id === tabId);
  if (!panel || !tab) throw new Error(`No tab "${tabId.slice(0, 200)}" is open on this device. Call ui_get_state for the current ids.`);
  const area = panel.id === DOCK_PANEL_ID ? "dock" : isWindowPanelId(panel.id) ? "window" : "grid";
  return describeTabFrom({
    tab, area, live: readTabLiveContent(tabId), offset,
    terminalSessionId: tab.type === "terminal" ? terminalSession(tabId) : null,
  });
}
