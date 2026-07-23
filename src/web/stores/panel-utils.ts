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

// ---------------------------------------------------------------------------
// Dock constants and types
// ---------------------------------------------------------------------------

/**
 * Reserved panel ID for the bottom dock.
 * This panel lives in the `panels` map but is intentionally excluded from `grid`
 * so all grid math (MAX_ROWS, split, column count) ignores it.
 */
export const DOCK_PANEL_ID = "__dock__";

/**
 * Tab types permitted inside the dock panel.
 * Enforced at load-time to prevent a crafted persisted blob from placing
 * arbitrary tab types in the privileged dock slot.
 */
export const DOCK_ALLOWED_TAB_TYPES = new Set<TabType>(["terminal", "system-monitor", "tunnels"]);

/** Visible/height state for the dock — stored per-project via projectDock map. */
export interface DockState {
  visible: boolean;
  /** Height as a percentage of the viewport, clamped to [15, 85]. */
  height: number;
}

export interface PanelLayout {
  panels: Record<string, Panel>;
  /** grid[row][col] = panelId */
  grid: string[][];
  focusedPanelId: string;
  /** Dock visibility + height for this project (optional for back-compat with old blobs). */
  dock?: DockState;
  /** The __dock__ panel's tab state for this project (optional for back-compat). */
  dockPanel?: Panel;
}

/**
 * Create the reserved dock panel with an empty tab list.
 * Always uses DOCK_PANEL_ID so there is only ever one dock panel per store instance.
 */
export function createDockPanel(): Panel {
  return {
    id: DOCK_PANEL_ID,
    tabs: [],
    activeTabId: null,
    tabHistory: [],
  };
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

/** Get next untitled number by scanning all panels */
export function getNextUntitledNumber(panels: Record<string, Panel>): number {
  let max = 0;
  for (const panel of Object.values(panels)) {
    for (const tab of panel.tabs) {
      const match = tab.id.match(/^editor:untitled-(\d+)$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

/** Derive deterministic tab ID from type + metadata */
export function deriveTabId(type: TabType, metadata?: Record<string, unknown>): string {
  switch (type) {
    case "editor":
      if (metadata?.viewerKey) return `editor:viewer:${metadata.viewerKey}`;
      if (metadata?.isUntitled) return `editor:untitled-${metadata.untitledNumber ?? 1}`;
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
    case "extension": {
      const vt = String(metadata?.viewType ?? "unknown").replace(/\.view$/, "");
      return `extension:${vt}`;
    }
    case "git-diff":
      return `git-diff:${metadata?.filePath ?? "unknown"}`;
    case "conflict-editor":
      return `conflict-editor:${metadata?.filePath ?? "unknown"}`;
    case "settings":
      return "settings";
    case "tunnels":
      return "tunnels";
    default:
      return `${type}:${randomId()}`;
  }
}

/**
 * Legacy migration: the old grid-only "ports" tab type was renamed to "tunnels"
 * and relocated to the dock. Strip any persisted "ports" tab from ALL panels
 * (grid panels + dock) so no stale type reaches deriveTabId/TAB_COMPONENTS,
 * which would otherwise mint a random id and crash on render. The user re-opens
 * "Cloudflare Tunnels" from the command palette (dock). Idempotent.
 */
function scrubLegacyPortsTabs(panel: Panel): Panel {
  const LEGACY = "ports";
  if (!panel.tabs.some((t) => (t.type as string) === LEGACY)) return panel;
  const removed = new Set(
    panel.tabs.filter((t) => (t.type as string) === LEGACY).map((t) => t.id),
  );
  const tabs = panel.tabs.filter((t) => !removed.has(t.id));
  const tabHistory = panel.tabHistory.filter((id) => !removed.has(id));
  const activeTabId =
    panel.activeTabId && !removed.has(panel.activeTabId)
      ? panel.activeTabId
      : (tabHistory[tabHistory.length - 1] ?? tabs[tabs.length - 1]?.id ?? null);
  return { ...panel, tabs, tabHistory, activeTabId };
}

export function migratePortsToTunnels(layout: PanelLayout): PanelLayout {
  const panels: Record<string, Panel> = {};
  for (const [id, p] of Object.entries(layout.panels)) panels[id] = scrubLegacyPortsTabs(p);
  const dockPanel = layout.dockPanel ? scrubLegacyPortsTabs(layout.dockPanel) : layout.dockPanel;
  return { ...layout, panels, dockPanel };
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
    // dock and dockPanel are passed through directly — callers set them explicitly.
    const withTimestamp = { ...layout, updatedAt: new Date().toISOString() };
    localStorage.setItem(storageKey(projectName), JSON.stringify(withTimestamp));
    // Debounced server sync — skip virtual __global__ project (not a real server project)
    if (projectName !== "__global__") syncWorkspaceToServer(projectName, layout);
  } catch { /* ignore */ }
}

export function loadPanelLayout(projectName: string): PanelLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(projectName));
    if (raw) {
      const layout = JSON.parse(raw) as PanelLayout;
      // migratePortsToTunnels MUST run before migrateTabIds so no legacy "ports"
      // tab reaches deriveTabId's default branch (random id → render crash).
      return migrateDockDefaults(migrateTabIds(migratePortsToTunnels(layout)));
    }
  } catch { /* ignore */ }

  // Migrate from old tab-store format
  const migrated = migrateOldTabStore(projectName);
  return migrated ? migrateDockDefaults(migratePortsToTunnels(migrated)) : null;
}

/**
 * Ensure dock fields are present with safe defaults for blobs written before
 * the dock feature existed, and defensively filter dockPanel.tabs to allowed types.
 *
 * Migration rules:
 *   - Missing `dock`      → { visible: false, height: 30 }
 *   - Missing `dockPanel` → empty dock panel (createDockPanel())
 *   - dockPanel.tabs with non-allowed types → stripped (security: prevent arbitrary
 *     tab types from appearing in the privileged dock slot via a crafted blob)
 */
function migrateDockDefaults(layout: PanelLayout): PanelLayout {
  const dock: DockState = layout.dock ?? { visible: false, height: 30 };

  let dockPanel: Panel;
  if (!layout.dockPanel) {
    dockPanel = createDockPanel();
  } else {
    // Filter tabs to allowed types only
    const allowedTabs = layout.dockPanel.tabs.filter((t) => DOCK_ALLOWED_TAB_TYPES.has(t.type));
    const allowedIds = new Set(allowedTabs.map((t) => t.id));
    const filteredHistory = layout.dockPanel.tabHistory.filter((id) => allowedIds.has(id));
    const activeTabId = layout.dockPanel.activeTabId && allowedIds.has(layout.dockPanel.activeTabId)
      ? layout.dockPanel.activeTabId
      : (filteredHistory[filteredHistory.length - 1] ?? allowedTabs[allowedTabs.length - 1]?.id ?? null);
    dockPanel = { ...layout.dockPanel, tabs: allowedTabs, tabHistory: filteredHistory, activeTabId };
  }

  return { ...layout, dock, dockPanel };
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
  if (projectName === "__global__") return null;
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

/**
 * Fetch a project's workspace from the server and, if it wins the conflict,
 * write it into localStorage so a subsequent load/switch picks it up.
 *
 * switchProject reads localStorage only. Projects whose layout lives solely in
 * the DB (opened on another device/tunnel, or after a local cache wipe) would
 * otherwise restore as an empty workspace. Returns true if localStorage was
 * overwritten with server data.
 */
export async function hydrateWorkspaceFromServer(projectName: string): Promise<boolean> {
  if (projectName === "__global__") return false;
  const server = await fetchWorkspaceFromServer(projectName);
  if (!server) return false;
  const key = `${STORAGE_PREFIX}${projectName}`;
  let local: PanelLayoutWithTimestamp | null = null;
  try {
    const raw = localStorage.getItem(key);
    local = raw ? (JSON.parse(raw) as PanelLayoutWithTimestamp) : null;
  } catch { /* corrupt blob → treat as absent */ }
  if (resolveWorkspaceConflict(local, server) !== server) return false;
  try {
    // Migrate the server blob BEFORE writing to localStorage — otherwise a
    // legacy "ports" tab from another device survives the hydrate and crashes
    // on the next loadPanelLayout render.
    const migrated = { ...migratePortsToTunnels(server), updatedAt: server.updatedAt };
    localStorage.setItem(key, JSON.stringify(migrated));
    return true;
  } catch {
    return false;
  }
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
