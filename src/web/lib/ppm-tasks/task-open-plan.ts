/**
 * Where opening a task shows it. Pure, so the rules are tested without a store.
 *
 * - A phone (below `md`, where no window renders) shows the task in a bottom sheet.
 * - A task already on screen (a tab in the grid, or a window) is brought forward as it is.
 * - A plain selection (a row clicked, an arrow key in the list) reuses the window that still
 *   shows a *preview*, the way a preview tab is reused: walking the list never stacks windows.
 * - Anything else gets a window of its own; at the window cap it falls back to a tab.
 */
import { isPreviewTab, taskIdOfTab, type PanelTabs } from "./task-tab-preview";
import { clampRect, MIN_SIZE, type Bounds, type Rect } from "@/components/floating-window/window-geometry";

export type TaskOpenPlan =
  | { kind: "sheet" }
  /** Open on screen already: the tab path focuses it and raises its window. */
  | { kind: "focus" }
  /** Swap the task in the window that shows a preview. */
  | { kind: "reuse-window"; panelId: string }
  | { kind: "new-window" }
  /** No window can open (the cap): a tab, as before. */
  | { kind: "tab" };

export interface TaskOpenState {
  mobile: boolean;
  /** The grid's panels and the windows' panels: what is on screen. */
  onScreen: readonly PanelTabs[];
  /** Which of `onScreen` are window panels. */
  isWindowPanel: (panelId: string) => boolean;
  windowCount: number;
  maxWindows: number;
}

export function planTaskOpen(state: TaskOpenState, taskId: string, keep: boolean): TaskOpenPlan {
  if (state.mobile) return { kind: "sheet" };
  if (state.onScreen.some((p) => p.tabs.some((t) => taskIdOfTab(t) === taskId))) return { kind: "focus" };
  if (!keep) {
    const preview = state.onScreen.find((p) => state.isWindowPanel(p.id) && p.tabs.some(isPreviewTab));
    if (preview) return { kind: "reuse-window", panelId: preview.id };
  }
  return state.windowCount < state.maxWindows ? { kind: "new-window" } : { kind: "tab" };
}

/** Wide enough for the page's two columns (it splits at 760px of its own width). */
const DEFAULT_SIZE = { w: 880, h: 720 };
const MARGIN = 16;
const RIGHT = 28;
const CASCADE = 28;

/**
 * The rect for a new task window. `open` is the task windows already on screen, front one last:
 * the new one steps off the front one. With none, the remembered rect, else a window on the right
 * that leaves the list and the code on the left readable.
 */
export function taskWindowSpawnRect(bounds: Bounds, open: readonly Rect[], remembered: Rect | null): Rect {
  const front = open[open.length - 1];
  if (front) return clampRect({ ...front, x: front.x + CASCADE, y: front.y + CASCADE }, bounds);
  if (remembered) return clampRect(remembered, bounds);
  const w = Math.min(DEFAULT_SIZE.w, bounds.w - MARGIN * 2);
  const h = Math.min(DEFAULT_SIZE.h, bounds.h - MARGIN * 2);
  return clampRect({ x: bounds.w - RIGHT - w, y: MARGIN, w, h }, bounds);
}

/**
 * A new task window keeps clear of the Tasks list while the list is open. `listRight` is the list's
 * right edge in the layer's coordinates (null when the list is not on screen). The layer starts at
 * the sidebar's edge, so this only bites a rect that hangs off the layer's left edge (where a
 * window was dragged, remembered or cascaded from). The window moves right of the list and, if
 * needed, narrows to fit; when what is left is narrower than a window can be, it may cover the list.
 */
export function keepClearOfList(rect: Rect, bounds: Bounds, listRight: number | null): Rect {
  if (listRight === null || rect.x >= listRight) return rect;
  const room = bounds.w - listRight;
  if (room < MIN_SIZE.w) return rect;
  return { ...rect, x: listRight, w: Math.min(rect.w, room) };
}
