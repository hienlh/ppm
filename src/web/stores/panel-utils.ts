import { randomId } from "@/lib/utils";
import type { Tab, TabType } from "./tab-store";

// ---------------------------------------------------------------------------
// Panel types
// ---------------------------------------------------------------------------
export interface Panel {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  tabHistory: string[];
}

export interface PanelLayout {
  panels: Record<string, Panel>;
  /** grid[row][col] = panelId */
  grid: string[][];
  focusedPanelId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function generatePanelId(): string {
  return `panel-${randomId()}`;
}

export function createPanel(tabs: Tab[] = [], activeTabId: string | null = null): Panel {
  return {
    id: generatePanelId(),
    tabs,
    activeTabId,
    tabHistory: activeTabId ? [activeTabId] : [],
  };
}

/** Max columns: 3 desktop, 1 mobile */
export function maxColumns(isMobile: boolean): number {
  return isMobile ? 1 : 3;
}

/** Max rows in the grid */
export const MAX_ROWS = 3;

// ---------------------------------------------------------------------------
// Grid manipulation
// ---------------------------------------------------------------------------
/** Add a new row to the grid (outer array) */
export function gridAddRow(grid: string[][], panelId: string): string[][] {
  return [...grid, [panelId]];
}

/** Add a column within an existing row (inner array) */
export function gridAddColumn(grid: string[][], rowIndex: number, panelId: string): string[][] {
  return grid.map((row, i) => (i === rowIndex ? [...row, panelId] : row));
}

export function gridRemovePanel(grid: string[][], panelId: string): string[][] {
  return grid
    .map((col) => col.filter((id) => id !== panelId))
    .filter((col) => col.length > 0);
}

export function findPanelPosition(grid: string[][], panelId: string): { row: number; col: number } | null {
  for (let r = 0; r < grid.length; r++) {
    const c = grid[r]!.indexOf(panelId);
    if (c !== -1) return { row: r, col: c };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic tab IDs
// ---------------------------------------------------------------------------

/** Derive deterministic tab ID from type + metadata */
export function deriveTabId(type: TabType, metadata?: Record<string, unknown>): string {
  switch (type) {
    case "editor":
      return `editor:${metadata?.filePath ?? "untitled"}`;
    case "chat": {
      const provider = metadata?.providerId ?? "default";
      return `chat:${provider}/${metadata?.sessionId ?? randomId()}`;
    }
    case "terminal":
      return `terminal:${metadata?.terminalIndex ?? 1}`;
    case "database":
      return `database:${metadata?.connectionId ?? "default"}:${metadata?.tableName ?? ""}`;
    case "sqlite":
      return `sqlite:${metadata?.filePath ?? "default"}`;
    case "postgres":
      return `postgres:${metadata?.connectionId ?? "default"}:${metadata?.tableName ?? ""}`;
    case "git-graph":
      return "git-graph";
    case "git-diff":
      return `git-diff:${metadata?.filePath ?? "unknown"}`;
    case "settings":
      return "settings";
    case "ports":
      return "ports";
    default:
      return `${type}:${randomId()}`;
  }
}

/** Migrate old random tab IDs to deterministic IDs */
export function migrateTabIds(layout: PanelLayout): PanelLayout {
  const migrated = { ...layout, panels: { ...layout.panels } };
  for (const [panelId, panel] of Object.entries(migrated.panels)) {
    const newTabs = panel.tabs.map((tab) => {
      if (tab.id.startsWith("tab-")) {
        const newId = deriveTabId(tab.type, tab.metadata);
        return { ...tab, id: newId };
      }
      return tab;
    });
    const idMap = new Map<string, string>();
    panel.tabs.forEach((old, i) => {
      if (old.id !== newTabs[i]!.id) idMap.set(old.id, newTabs[i]!.id);
    });
    const newActive = idMap.get(panel.activeTabId ?? "") ?? panel.activeTabId;
    const newHistory = panel.tabHistory.map((h) => idMap.get(h) ?? h);
    migrated.panels[panelId] = { ...panel, tabs: newTabs, activeTabId: newActive, tabHistory: newHistory };
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const STORAGE_PREFIX = "ppm-panels-";
const OLD_STORAGE_PREFIX = "ppm-tabs-";

function storageKey(projectName: string): string {
  return `${STORAGE_PREFIX}${projectName}`;
}

export function savePanelLayout(projectName: string, layout: PanelLayout): void {
  try {
    const withTimestamp = { ...layout, updatedAt: new Date().toISOString() };
    localStorage.setItem(storageKey(projectName), JSON.stringify(withTimestamp));
    // Debounced server sync
    syncWorkspaceToServer(projectName, layout);
  } catch { /* ignore */ }
}

export function loadPanelLayout(projectName: string): PanelLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(projectName));
    if (raw) {
      const layout = JSON.parse(raw) as PanelLayout;
      return migrateTabIds(layout);
    }
  } catch { /* ignore */ }

  // Migrate from old tab-store format
  return migrateOldTabStore(projectName);
}

// ---------------------------------------------------------------------------
// Server sync
// ---------------------------------------------------------------------------

export interface PanelLayoutWithTimestamp extends PanelLayout {
  updatedAt: string;
}

/** Fetch workspace from server */
export async function fetchWorkspaceFromServer(
  projectName: string,
): Promise<PanelLayoutWithTimestamp | null> {
  try {
    const headers: Record<string, string> = {};
    const token = localStorage.getItem("ppm-auth-token");
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/workspace`, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.ok || !json.data) return null;
    return { ...json.data.layout, updatedAt: json.data.updatedAt };
  } catch {
    return null;
  }
}

/** Save workspace to server (debounced per project) */
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function syncWorkspaceToServer(projectName: string, layout: PanelLayout): void {
  const existing = syncTimers.get(projectName);
  if (existing) clearTimeout(existing);

  syncTimers.set(projectName, setTimeout(async () => {
    syncTimers.delete(projectName);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = localStorage.getItem("ppm-auth-token");
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`/api/project/${encodeURIComponent(projectName)}/workspace`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ layout }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data?.updatedAt) {
          const key = `${STORAGE_PREFIX}${projectName}`;
          const raw = localStorage.getItem(key);
          if (raw) {
            const local = JSON.parse(raw);
            local.updatedAt = json.data.updatedAt;
            localStorage.setItem(key, JSON.stringify(local));
          }
        }
      }
    } catch { /* silent fail — localStorage is still the cache */ }
  }, 1500));
}

/** Compare local vs server timestamps, return newer layout */
export function resolveWorkspaceConflict(
  local: PanelLayoutWithTimestamp | null,
  server: PanelLayoutWithTimestamp | null,
): PanelLayoutWithTimestamp | null {
  if (!local && !server) return null;
  if (!local) return server!;
  if (!server) return local;

  const localTime = new Date(local.updatedAt).getTime();
  const serverTime = new Date(server.updatedAt).getTime();
  return serverTime >= localTime ? server : local;
}

// ---------------------------------------------------------------------------
// Old format migration
// ---------------------------------------------------------------------------

function migrateOldTabStore(projectName: string): PanelLayout | null {
  try {
    const raw = localStorage.getItem(`${OLD_STORAGE_PREFIX}${projectName}`);
    if (!raw) return null;
    const old = JSON.parse(raw) as { tabs: Tab[]; activeTabId: string | null };
    if (!old.tabs?.length) return null;

    const panel = createPanel(old.tabs, old.activeTabId);
    const layout: PanelLayout = {
      panels: { [panel.id]: panel },
      grid: [[panel.id]],
      focusedPanelId: panel.id,
    };
    // Save new format and clean old
    savePanelLayout(projectName, layout);
    localStorage.removeItem(`${OLD_STORAGE_PREFIX}${projectName}`);
    return layout;
  } catch {
    return null;
  }
}
