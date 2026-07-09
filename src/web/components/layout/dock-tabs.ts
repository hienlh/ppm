/**
 * Shared helper: count the dock (__dock__) tabs belonging to the active project.
 *
 * The shared __dock__ panel holds tabs from all projects; the status-bar toggle
 * count and the mobile-nav "running sessions" indicator both need only the
 * active project's tabs. Kept DOM-free for unit testing + DRY across consumers.
 */
import type { Panel } from "@/stores/panel-utils";

export function countDockTabs(
  dockPanel: Panel | undefined,
  activeProjectName: string | null,
): number {
  if (!dockPanel) return 0;
  return dockPanel.tabs.filter(
    (t) => !t.projectId || !activeProjectName || t.projectId === activeProjectName,
  ).length;
}
