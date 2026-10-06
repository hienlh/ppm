import { tabSessionId } from "./tab-session-id";

/**
 * Where a tab the AI asked for goes (`open_file` / `open_preview`, opened by `open-ai-tab.ts`).
 *
 * On a desktop the chat stays on screen. The file opens in another panel, and when the chat's
 * panel is the only one it is split so the file sits to the chat's right. A tab already showing
 * the file is reused, unless it is hidden behind the chat in the chat's own panel: then it is
 * moved out beside the chat. A phone shows one panel at a time, so there the tab opens in the
 * first panel and takes the screen; the tab bar leads back to the chat.
 *
 * Pure, so it is tested without the stores, which read localStorage when they are imported.
 */

export interface PlacementTab {
  id: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface PlacementPanel {
  id: string;
  tabs: PlacementTab[];
  activeTabId: string | null;
}

export interface AiTabPlacementInput {
  grid: string[][];
  panels: Record<string, PlacementPanel | undefined>;
  focusedPanelId: string;
  mobile: boolean;
  /** The chat that asked; the tab goes beside it. */
  sessionId: string;
  /** Whether a tab already shows the file. */
  isTarget: (tab: PlacementTab) => boolean;
}

export type AiTabPlacement =
  /** The file is open where it can be seen: bring its tab to the front. */
  | { kind: "focus"; tabId: string; panelId: string }
  /** The file is open behind the chat: move its tab to `toPanelId`, or split it out to the right when null. */
  | { kind: "move"; tabId: string; fromPanelId: string; toPanelId: string | null }
  /** Open a new tab in `panelId`, then split it out to the right when `split`. */
  | { kind: "open"; panelId: string; split: boolean };

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[/\\])/;

/** Whether `tab` is an editor tab showing this file, as `open-ai-tab.ts` names it. */
export function isTabForFile(tab: PlacementTab, filePath: string, projectName: string | null): boolean {
  if (tab.type !== "editor") return false;
  const meta = tab.metadata ?? {};
  if (meta.viewerKey || meta.isUntitled || meta.inlineContent != null || meta.filePath !== filePath) return false;
  // A relative path means nothing without its project; an absolute one names the file alone.
  return ABSOLUTE_PATH.test(filePath) || meta.projectName === projectName;
}

export function chooseAiTabPlacement(input: AiTabPlacementInput): AiTabPlacement | null {
  const { grid, panels, focusedPanelId, sessionId } = input;
  const onGrid = grid.flat().filter((id) => panels[id]);
  if (onGrid.length === 0) return null;
  const chatPanelId = onGrid.find((id) => panels[id]!.tabs.some((t) => tabSessionId(t) === sessionId)) ?? null;
  const existing = findExisting(onGrid, chatPanelId, input);

  if (input.mobile) return existing ? { kind: "focus", ...existing } : { kind: "open", panelId: onGrid[0]!, split: false };

  // The chat is in a floating window or not in this workspace at all: every grid panel is beside it.
  if (chatPanelId === null) {
    if (existing) return { kind: "focus", ...existing };
    return { kind: "open", panelId: onGrid.includes(focusedPanelId) ? focusedPanelId : onGrid[0]!, split: false };
  }

  const chatPanel = panels[chatPanelId]!;
  const chatShowing = chatPanel.tabs.some((t) => t.id === chatPanel.activeTabId && tabSessionId(t) === sessionId);
  const beside = besidePanel(grid, chatPanelId, focusedPanelId, onGrid);
  if (existing) {
    if (existing.panelId !== chatPanelId || !chatShowing) return { kind: "focus", ...existing };
    return { kind: "move", tabId: existing.tabId, fromPanelId: chatPanelId, toPanelId: beside };
  }
  return beside ? { kind: "open", panelId: beside, split: false } : { kind: "open", panelId: chatPanelId, split: true };
}

/** A tab already showing the file, looking outside the chat's panel first. */
function findExisting(onGrid: string[], chatPanelId: string | null, input: AiTabPlacementInput): { tabId: string; panelId: string } | null {
  const order = [...onGrid.filter((id) => id !== chatPanelId), ...(chatPanelId ? [chatPanelId] : [])];
  for (const panelId of order) {
    const tab = input.panels[panelId]!.tabs.find(input.isTarget);
    if (tab) return { tabId: tab.id, panelId };
  }
  return null;
}

/**
 * The panel a file opens in beside the chat: the one the user last focused, when that is not
 * the chat's own; otherwise the chat's neighbour to the right, then to the left, then any other.
 */
function besidePanel(grid: string[][], chatPanelId: string, focusedPanelId: string, onGrid: string[]): string | null {
  if (focusedPanelId !== chatPanelId && onGrid.includes(focusedPanelId)) return focusedPanelId;
  const row = grid.find((r) => r.includes(chatPanelId)) ?? [];
  const col = row.indexOf(chatPanelId);
  const candidates = [...row.slice(col + 1), ...row.slice(0, col).reverse(), ...grid.filter((r) => r !== row).flat()];
  return candidates.find((id) => id !== chatPanelId && onGrid.includes(id)) ?? null;
}
