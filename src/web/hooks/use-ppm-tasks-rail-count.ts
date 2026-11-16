/**
 * The Tasks rail icon's count: open tasks whose effective urgency is Now, in the scope the Tasks
 * section shows (the active project, or every switched-on project). Zero hides the badge.
 */
import { usePpmTaskProjects } from "@/hooks/use-ppm-task-projects";
import { useTaskViewStore } from "@/stores/ppm-tasks-view-store";
import type { TaskProjectSummary } from "../../shared/ppm-tasks-api";

export function railNowCount(projects: readonly TaskProjectSummary[], scope: "project" | "all", activeProject: string | null, hidden: readonly string[] = []): number {
  if (scope === "all") return projects.filter((p) => p.enabled && !hidden.includes(p.name)).reduce((n, p) => n + p.now, 0);
  const own = projects.find((p) => p.name === activeProject);
  return own?.enabled ? own.now : 0;
}

export function usePpmTasksRailCount(activeProject: string | null): number {
  const { projects } = usePpmTaskProjects();
  const scope = useTaskViewStore((s) => s.scope);
  const hidden = useTaskViewStore((s) => s.hiddenProjects);
  return railNowCount(projects, scope, activeProject, hidden);
}
