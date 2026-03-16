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
  /** grid[col][row] = panelId */
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

/** Max rows per column */
export const MAX_ROWS = 2;

// ---------------------------------------------------------------------------
// Grid manipulation
// ---------------------------------------------------------------------------
export function gridAddColumn(grid: string[][], panelId: string): string[][] {
  return [...grid, [panelId]];
}

export function gridAddRow(grid: string[][], colIndex: number, panelId: string): string[][] {
  return grid.map((col, i) => (i === colIndex ? [...col, panelId] : col));
}

export function gridRemovePanel(grid: string[][], panelId: string): string[][] {
  return grid
    .map((col) => col.filter((id) => id !== panelId))
    .filter((col) => col.length > 0);
}

export function findPanelPosition(grid: string[][], panelId: string): { col: number; row: number } | null {
  for (let c = 0; c < grid.length; c++) {
    const r = grid[c]!.indexOf(panelId);
    if (r !== -1) return { col: c, row: r };
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
