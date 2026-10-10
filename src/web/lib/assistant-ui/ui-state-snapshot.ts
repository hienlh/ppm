import { DOCK_PANEL_ID, visibleTabs, windowPanelId, type DockState, type Panel } from "@/stores/panel-utils";
import type { Tab } from "@/stores/tab-store";
import type { WindowRuntimeState } from "@/components/floating-window/window-store-types";

/**
 * What the PPM Assistant's `ui_get_state` reads: the layout this device shows, as plain data.
 * Pure — the caller hands in the stores' state — so it can be tested without a DOM.
 *
 * A tab's metadata is mostly private working state (unsaved editor text, a half-typed SQL
 * query, a pending chat message, picked accounts), so only the keys listed for its type are
 * passed on, and only when they are short scalars. Every title is cut, and the whole snapshot
 * is held under {@link MAX_SNAPSHOT_CHARS}: tabs are dropped from the end of each panel until
 * it fits, and the snapshot says how many.
 */

export const MAX_SNAPSHOT_CHARS = 32 * 1024;
export const MAX_SNAPSHOT_TITLE_CHARS = 160;
const MAX_METADATA_VALUE_CHARS = 300;

const SESSION_KEYS = ["sessionId", "providerId"];
const DB_KEYS = ["connectionId", "connectionName", "dbType", "database", "schemaName", "tableName", "objectName", "objectKind"];

/** Per tab type, the metadata keys that say which thing the tab shows. */
export const TAB_METADATA_ALLOW: Readonly<Record<string, readonly string[]>> = {
  chat: SESSION_KEYS,
  assistant: SESSION_KEYS,
  design: ["designSlug", ...SESSION_KEYS],
  editor: ["filePath", "lineNumber", "isUntitled", "language"],
  "conflict-editor": ["filePath"],
  "git-diff": ["filePath", "ref1", "ref2"],
  "session-review": ["sessionId"],
  terminal: ["terminalIndex"],
  database: DB_KEYS,
  "db-structure": DB_KEYS,
  "db-sql": DB_KEYS,
  "db-query": DB_KEYS,
  "db-impexp": DB_KEYS,
  "db-connection": DB_KEYS,
  sqlite: ["filePath", "tableName"],
  "web-preview": ["url"],
  extension: ["viewType"],
  "extension-webview": ["viewType"],
  "ai-resource": ["resourceType", "name"],
  android: ["avdId"],
  group: ["groupId"],
  settings: ["category"],
};

export interface SnapshotTab {
  id: string;
  type: string;
  title: string;
  project: string | null;
  active: boolean;
  details?: Record<string, string | number | boolean>;
}

export interface SnapshotPanel {
  id: string;
  area: "grid" | "dock" | "window";
  /** Row and column in the grid; grid panels only. */
  position?: { row: number; col: number };
  focused: boolean;
  activeTabId: string | null;
  tabs: SnapshotTab[];
  /** Tabs left out to keep the snapshot within its size. */
  omittedTabs?: number;
}

export interface SnapshotWindow {
  id: string;
  kind: string;
  title: string;
  state: string;
  /** The window in front of the others. */
  front: boolean;
  /** For a window hosting tabs, the panel that holds them. */
  panelId?: string;
}

export interface UiStateSnapshot {
  currentProject: string | null;
  layout: "phone" | "desktop";
  focusedPanelId: string;
  panels: SnapshotPanel[];
  dock: { visible: boolean; expanded: boolean };
  windows: SnapshotWindow[];
  /** Present when tabs had to be left out. */
  truncated?: string;
}

export interface UiStateInput {
  currentProject: string | null;
  layout: "phone" | "desktop";
  panels: Record<string, Panel>;
  grid: string[][];
  focusedPanelId: string;
  dock: DockState;
  dockExpanded: boolean;
  windows: WindowRuntimeState[];
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The allow-listed, scalar metadata of a tab; undefined when nothing qualifies. */
export function tabDetails(tab: Pick<Tab, "type" | "metadata">): SnapshotTab["details"] {
  const allowed = TAB_METADATA_ALLOW[tab.type];
  if (!allowed || !tab.metadata) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = tab.metadata[key];
    if (typeof value === "string" && value) out[key] = cut(value, MAX_METADATA_VALUE_CHARS);
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function snapshotTab(tab: Tab, activeTabId: string | null): SnapshotTab {
  const metaProject = tab.metadata?.projectName;
  const details = tabDetails(tab);
  return {
    id: tab.id,
    type: tab.type,
    title: cut(tab.title ?? "", MAX_SNAPSHOT_TITLE_CHARS),
    project: tab.projectId ?? (typeof metaProject === "string" && metaProject ? metaProject : null),
    active: tab.id === activeTabId,
    ...(details ? { details } : {}),
  };
}

function snapshotPanel(panel: Panel, area: SnapshotPanel["area"], input: UiStateInput, position?: SnapshotPanel["position"]): SnapshotPanel {
  // A floating window shows its tabs whichever project is current; a panel shows that project's.
  const tabs = area === "window" ? panel.tabs : visibleTabs(panel.tabs, input.currentProject);
  const activeTabId = tabs.some((t) => t.id === panel.activeTabId) ? panel.activeTabId : null;
  return {
    id: panel.id,
    area,
    ...(position ? { position } : {}),
    focused: panel.id === input.focusedPanelId,
    activeTabId,
    tabs: tabs.map((t) => snapshotTab(t, activeTabId)),
  };
}

function windowTitleOf(win: WindowRuntimeState, panels: Record<string, Panel>): string {
  const hosted = panels[windowPanelId(win.id)];
  const tab = hosted?.tabs.find((t) => t.id === hosted.activeTabId) ?? hosted?.tabs[0];
  const explicit = win.payload?.title;
  const title = tab?.title || (typeof explicit === "string" && explicit.trim() ? explicit : win.kind);
  return cut(title, MAX_SNAPSHOT_TITLE_CHARS);
}

/** Keeps the first `keep` tabs of every panel that has more. */
function capTabs(panels: SnapshotPanel[], keep: number): SnapshotPanel[] {
  return panels.map((p) => (p.tabs.length <= keep ? p : {
    ...p, tabs: p.tabs.slice(0, keep), omittedTabs: (p.omittedTabs ?? 0) + p.tabs.length - keep,
  }));
}

export function buildUiStateSnapshot(input: UiStateInput): UiStateSnapshot {
  const panels: SnapshotPanel[] = [];
  input.grid.forEach((row, r) => row.forEach((id, c) => {
    const panel = input.panels[id];
    if (panel) panels.push(snapshotPanel(panel, "grid", input, { row: r, col: c }));
  }));
  const dock = input.panels[DOCK_PANEL_ID];
  if (dock) panels.push(snapshotPanel(dock, "dock", input));
  const ordered = [...input.windows].sort((a, b) => a.rank - b.rank);
  const shown = ordered.filter((w) => w.state !== "minimized");
  const frontId = shown[shown.length - 1]?.id ?? null;
  const windows: SnapshotWindow[] = ordered.map((win) => {
    const panelId = windowPanelId(win.id);
    const hosted = input.panels[panelId];
    if (hosted) panels.push(snapshotPanel(hosted, "window", input));
    return {
      id: win.id, kind: win.kind, title: windowTitleOf(win, input.panels), state: win.state,
      front: win.id === frontId, ...(hosted ? { panelId } : {}),
    };
  });
  let snapshot: UiStateSnapshot = {
    currentProject: input.currentProject,
    layout: input.layout,
    focusedPanelId: input.focusedPanelId,
    panels,
    dock: { visible: input.dock.visible, expanded: input.dockExpanded },
    windows,
  };
  const size = () => JSON.stringify(snapshot).length;
  let keep = Math.max(0, ...panels.map((p) => p.tabs.length));
  while (size() > MAX_SNAPSHOT_CHARS && keep > 0) {
    keep = Math.floor(keep / 2);
    snapshot = { ...snapshot, panels: capTabs(snapshot.panels, keep) };
  }
  const omitted = snapshot.panels.reduce((n, p) => n + (p.omittedTabs ?? 0), 0);
  if (omitted) snapshot.truncated = `${omitted} tabs left out to keep this answer small`;
  return snapshot;
}
