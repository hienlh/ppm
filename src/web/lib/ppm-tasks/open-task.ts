/**
 * The one way to open a task from anywhere — the Tasks list, a task chip, the palette, a child or
 * a linked task on a task's page. On a desktop the task opens in a floating window, so the tab the
 * user was working in stays where it was; below `md` (no windows there) it opens in a bottom sheet
 * over the screen. The rules are `planTaskOpen`; this file carries them out.
 *
 * A task the user turned into a tab stays a tab: opening it again focuses that tab. Opening a task
 * that already has a window brings that window forward rather than opening another. The deep link
 * (`/project/<p>/task/<id>`) still opens a tab, and so do "Open as tab" in the window and "Full
 * screen" in the sheet (`openTaskTab`).
 */
import { usePanelStore } from "@/stores/panel-store";
import { isWindowPanelId, windowIdFromPanelId } from "@/stores/panel-utils";
import { useTaskSheetStore } from "@/stores/task-sheet-store";
import type { Tab } from "@/stores/tab-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { MAX_WINDOWS } from "@/components/floating-window/window-geometry";
import { openTaskTab, taskTabDef, type TaskTabTarget } from "./open-task-tab";
import { planTaskOpen } from "./task-open-plan";
import { keptMetadata, taskIdOfTab } from "./task-tab-preview";
import { CLOSE_NAVIGATION } from "./close-navigation";
import { loadTaskWindowRect, openTaskWindowRects, taskWindowSpawnRect, watchTaskWindowRects } from "./task-window-rect";

export function openTask(task: TaskTabTarget, opts: { keep?: boolean } = {}): void {
  const store = usePanelStore.getState();
  const mobile = store.isMobile();
  const windowPanels = mobile ? [] : Object.keys(store.panels).filter(isWindowPanelId);
  const onScreen = [...store.grid.flat(), ...windowPanels].map((id) => store.panels[id]).filter((p) => !!p);
  const plan = planTaskOpen({
    mobile,
    onScreen,
    isWindowPanel: isWindowPanelId,
    windowCount: Object.keys(useWindowStore.getState().windows).length,
    maxWindows: MAX_WINDOWS,
  }, task.id, opts.keep === true);

  switch (plan.kind) {
    case "sheet":
      useTaskSheetStore.getState().show(task);
      return;
    case "focus":
    case "tab":
      openTaskTab(task, opts);
      return;
    case "reuse-window": {
      store.openTab(taskTabDef(task, opts), plan.panelId);
      const windowId = windowIdFromPanelId(plan.panelId);
      if (windowId) useWindowStore.getState().focus(windowId);
      return;
    }
    case "new-window": {
      watchTaskWindowRects();
      const rect = taskWindowSpawnRect(useWindowStore.getState().bounds, openTaskWindowRects(), loadTaskWindowRect());
      if (!store.openTabInNewWindow(taskTabDef(task, opts), { rect })) openTaskTab(task, opts);
    }
  }
}

/**
 * "Open as tab" in a task window's titlebar: the task moves into the grid as a kept tab (the user
 * chose a tab for it, so the next selection must not replace it) and the window closes.
 */
export function moveTaskWindowToTab(tab: Tab): void {
  const store = usePanelStore.getState();
  const panel = store.getPanelForTab(tab.id);
  const windowId = panel ? windowIdFromPanelId(panel.id) : null;
  if (!windowId) return;
  if (tab.metadata?.preview === true) store.updateTab(tab.id, { metadata: keptMetadata(tab.metadata) });
  store.redockFromWindow(windowId, null);
}

/** The window a task's page is open in, if it is in one. */
export function taskWindowIdOf(panels: Record<string, { id: string; tabs: Pick<Tab, "type" | "metadata">[] }>, taskId: string): string | null {
  for (const p of Object.values(panels)) {
    if (!isWindowPanelId(p.id)) continue;
    if (p.tabs.some((t) => taskIdOfTab(t) === taskId)) return windowIdFromPanelId(p.id);
  }
  return null;
}

/**
 * A desktop task window opens a chat (Open chat, Start chat, Ask manager): the chat opens in the
 * grid, which the window would cover, so the window goes down to the dock. The task stays open;
 * its chip in the dock brings it back. A task shown as a tab is left as it is.
 */
export function minimizeTaskWindow(taskId: string): void {
  const windowId = taskWindowIdOf(usePanelStore.getState().panels, taskId);
  if (windowId && useWindowStore.getState().windows[windowId]) useWindowStore.getState().setState(windowId, "minimized");
}

/**
 * The phone's sheet is left for the screen behind it: the sheet and the navigation drawer it may
 * have been opened from close. A chat the task opens (Open chat, Start chat, Ask manager) shows
 * there, so it must not stay hidden under them.
 */
export function leaveTaskSheet(): void {
  useTaskSheetStore.getState().close();
  window.dispatchEvent(new CustomEvent(CLOSE_NAVIGATION));
}

/** "Full screen" in the phone's sheet: the sheet and the drawer close, and the task opens as a tab. */
export function openTaskFullScreen(task: TaskTabTarget): void {
  leaveTaskSheet();
  openTaskTab(task, { keep: true });
}
