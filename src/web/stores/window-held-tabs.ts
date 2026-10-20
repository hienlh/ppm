import type { Tab } from "./tab-store";
import { type Panel, type PanelLayout, isWindowPanelId } from "./panel-utils";

/**
 * Grid tabs a project's loaded layout names that one of this device's floating windows holds
 * instead. Kept apart from panel-store so every writer of a layout — the panel store's own saves
 * and the dock's — can put them back without importing the store (which imports the dock).
 */

/** A grid tab a loaded layout names that one of this device's floating windows holds instead. */
export interface WindowHeldTab { panelId: string; tab: Tab; index: number }

/** Ids of every tab one of this device's floating windows holds. */
export function windowTabIds(panels: Record<string, Panel>): Set<string> {
  return new Set(Object.entries(panels).filter(([id]) => isWindowPanelId(id)).flatMap(([, p]) => p.tabs.map((t) => t.id)));
}

/** Per project, the grid tabs its loaded layout named that a window here holds instead. */
const windowHeldByProject = new Map<string, WindowHeldTab[]>();

/** Remember what a freshly loaded layout named that a window here holds. */
export function rememberWindowHeldTabs(project: string, held: WindowHeldTab[]): void {
  windowHeldByProject.set(project, held);
}

/**
 * `layout` with the tabs a window here holds put back where the loaded layout had them, for
 * writing. The grid this device shows leaves them out, but the layout is shared through the
 * server, and writing it as shown would delete them for every device without that window.
 *
 * A tab is put back only while a window still holds it and nothing in `layout` does: once the
 * window closes it or it moves back into the grid or the dock, this device's choice is the one
 * written, and it is forgotten. If its panel is gone it goes to the focused one.
 */
export function withWindowHeldTabs(project: string, layout: PanelLayout, livePanels: Record<string, Panel>): PanelLayout {
  const held = windowHeldByProject.get(project);
  if (!held?.length) return layout;
  const inWindows = windowTabIds(livePanels);
  const written = new Set([...Object.values(layout.panels), ...(layout.dockPanel ? [layout.dockPanel] : [])].flatMap((p) => p.tabs.map((t) => t.id)));
  const still = held.filter((h) => inWindows.has(h.tab.id) && !written.has(h.tab.id));
  windowHeldByProject.set(project, still);
  if (still.length === 0) return layout;
  const panels = { ...layout.panels };
  for (const h of still) {
    const pid = panels[h.panelId] ? h.panelId : panels[layout.focusedPanelId] ? layout.focusedPanelId : layout.grid.flat().find((id) => panels[id]);
    if (!pid) continue;
    const panel = panels[pid]!;
    const tabs = [...panel.tabs];
    tabs.splice(Math.min(h.index, tabs.length), 0, h.tab);
    panels[pid] = { ...panel, tabs };
  }
  return { ...layout, panels };
}
