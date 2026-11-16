/**
 * Shows the Tasks section of the sidebar on a task: the section made current, a scope that holds
 * the task (all projects when it belongs to another project than the one open, its project's chip
 * switched back on), the task selected, and — with `openList` — the section on screen: the
 * navigation drawer on a phone, the sidebar expanded on a desktop. The manager chat's Tasks chip
 * calls it for a row (with its tab opened as well) and for "Show in sidebar".
 */
import { OPEN_NAVIGATION } from "@/components/database/db-sidebar-reveal";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ppmTasksStore } from "@/stores/ppm-tasks-store";
import { useTaskViewStore } from "@/stores/ppm-tasks-view-store";

/** The scope change a task needs to be in the list: none, or all projects (with its chip on). */
export function scopeForTask(
  task: { project: string },
  view: { scope: "project" | "all"; hiddenProjects: readonly string[] },
  activeProject: string | null,
): { scope: "project" | "all"; unhide: boolean } {
  const scope = view.scope === "project" && activeProject === task.project ? "project" : "all";
  return { scope, unhide: scope === "all" && view.hiddenProjects.includes(task.project) };
}

export function revealTaskInSidebar(task: { id?: string; project: string }, opts: { openList?: boolean } = {}): void {
  const view = useTaskViewStore.getState();
  const active = useProjectStore.getState().activeProject?.name ?? null;
  const next = scopeForTask(task, view, active);
  if (next.scope !== view.scope) view.setScope(next.scope);
  if (next.unhide) view.toggleProject(task.project);
  if (task.id) ppmTasksStore.getState().select(task.id);

  const settings = useSettingsStore.getState();
  if (settings.sidebarActiveTab !== "tasks") settings.setSidebarActiveTab("tasks");
  if (!opts.openList) return;
  if (isMobileDevice()) window.dispatchEvent(new CustomEvent(OPEN_NAVIGATION, { detail: { tab: "tasks" } }));
  else if (settings.sidebarCollapsed) settings.toggleSidebar();
}
