/**
 * localStorage persistence for the off-grid panels that host detached tabs.
 *
 * Deliberately its own global key instead of a field inside `PanelLayout`: floating
 * windows are global (one `ppm-windows` blob for the whole app) while a PanelLayout is
 * per project. Folding a global panel into a per-project blob is what forced the
 * merge/union machinery the dock needs on every project switch. Consequence, accepted:
 * window panels are not synced to the server workspace — the same limitation the window
 * geometry already has.
 */
import type { Panel } from "./panel-utils";
import { isWindowPanelId } from "./panel-utils";
import type { Tab, TabType } from "./tab-store";

const STORAGE_KEY = "ppm-window-panels";

/**
 * Tab types a persisted window panel may bring back. Written as an exhaustive record so
 * adding a TabType is a compile error here rather than a silent gap. `system-monitor` is
 * false because it can never be popped out; everything else a crafted blob names is
 * rejected, so it cannot mount an arbitrary component in the privileged window slot.
 */
const POPPABLE_TAB_TYPES: Record<TabType, boolean> = {
  terminal: true,
  chat: true,
  editor: true,
  database: true,
  sqlite: true,
  postgres: true,
  "git-diff": true,
  settings: true,
  extension: true,
  "extension-webview": true,
  "conflict-editor": true,
  "system-monitor": false,
  "git-log": true,
  "ai-resource": true,
  group: true,
};

export function isPoppableTabType(type: unknown): type is TabType {
  return typeof type === "string" && POPPABLE_TAB_TYPES[type as TabType] === true;
}

function isValidTab(value: unknown): value is Tab {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === "string" && !!t.id && typeof t.title === "string" && isPoppableTabType(t.type);
}

/** Keep only the window panels out of the full panels map, dropping empty ones. */
function selectWindowPanels(panels: Record<string, Panel>): Record<string, Panel> {
  const out: Record<string, Panel> = {};
  for (const [id, panel] of Object.entries(panels)) {
    if (!isWindowPanelId(id) || panel.tabs.length === 0) continue;
    out[id] = panel;
  }
  return out;
}

export function saveWindowPanels(panels: Record<string, Panel>): void {
  try {
    const windowPanels = selectWindowPanels(panels);
    if (Object.keys(windowPanels).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(windowPanels));
  } catch {
    /* quota exceeded or storage disabled — never block a tab move over persistence */
  }
}

/** Read persisted window panels, dropping anything malformed or not allowed in a window. */
export function loadWindowPanels(): Record<string, Panel> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, Panel> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isWindowPanelId(id) || !value || typeof value !== "object") continue;
    const panel = value as Record<string, unknown>;
    if (!Array.isArray(panel.tabs)) continue;
    const tabs = panel.tabs.filter(isValidTab);
    if (tabs.length === 0) continue;
    const ids = new Set(tabs.map((t) => t.id));
    const tabHistory = Array.isArray(panel.tabHistory)
      ? panel.tabHistory.filter((h): h is string => typeof h === "string" && ids.has(h))
      : [];
    const activeTabId =
      typeof panel.activeTabId === "string" && ids.has(panel.activeTabId)
        ? panel.activeTabId
        : (tabHistory[tabHistory.length - 1] ?? tabs[tabs.length - 1]!.id);
    out[id] = { id, tabs, activeTabId, tabHistory };
  }
  return out;
}

export function clearWindowPanels(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}
