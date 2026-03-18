import { randomId } from "@/lib/utils";
import type { Tab } from "./tab-store";

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
// Persistence
// ---------------------------------------------------------------------------
const STORAGE_PREFIX = "ppm-panels-";
const OLD_STORAGE_PREFIX = "ppm-tabs-";

function storageKey(projectName: string): string {
  return `${STORAGE_PREFIX}${projectName}`;
}

export function savePanelLayout(projectName: string, layout: PanelLayout): void {
  try {
    localStorage.setItem(storageKey(projectName), JSON.stringify(layout));
  } catch { /* ignore */ }
}

export function loadPanelLayout(projectName: string): PanelLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(projectName));
    if (raw) return JSON.parse(raw) as PanelLayout;
  } catch { /* ignore */ }

  // Migrate from old tab-store format
  return migrateOldTabStore(projectName);
}

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
