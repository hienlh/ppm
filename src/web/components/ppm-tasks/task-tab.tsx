/**
 * The `task` tab: one task's page in the main area. It reads the task (kept current by the store),
 * the project's task settings, and whether the tab is still a preview; keeps the tab's title in
 * step with the task's; and renders the page for the viewport.
 *
 * P6 seam: the phone page plugs in at `DetailView` below (`useIsMobile()` branch), taking the
 * same `TaskDetailViewProps`.
 */
import { useEffect } from "react";
import { Loader2 } from "@/lib/icons";
import { usePpmTask } from "@/hooks/use-ppm-tasks";
import { usePpmTaskProjectSettings } from "@/hooks/use-ppm-task-projects";
import { ppmTasksStore } from "@/stores/ppm-tasks-store";
import { useTabStore } from "@/stores/tab-store";
import { syncTaskTabTitle } from "@/lib/ppm-tasks/open-task-tab";
import { TaskDetailDesktop, type TaskDetailViewProps } from "./task-detail-desktop";

/** The page a viewport draws (P6 adds the phone page here). */
const DetailView: (p: TaskDetailViewProps) => React.ReactNode = TaskDetailDesktop;

export function TaskTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  const taskId = typeof metadata?.taskId === "string" ? metadata.taskId : null;
  const preview = metadata?.preview === true;
  const { detail, loading, error } = usePpmTask(taskId);
  const project = detail?.task.project ?? (typeof metadata?.projectName === "string" ? metadata.projectName : null);
  const { settings } = usePpmTaskProjectSettings(project);
  const active = useTabStore((s) => !!tabId && s.activeTabId === tabId);

  useEffect(() => { if (detail) syncTaskTabTitle(tabId, detail.task.title); }, [detail?.task.title, tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The list's selection follows the task shown in front.
  useEffect(() => { if (active && taskId) ppmTasksStore.getState().select(taskId); }, [active, taskId]);

  if (!taskId) return <p className="p-6 text-sm text-text-3">This tab names no task.</p>;
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-text-3">
        {loading ? <Loader2 className="size-5 animate-spin" /> : <p>{error ?? "This task could not be read."}</p>}
      </div>
    );
  }
  return <DetailView detail={detail} settings={settings} preview={preview} />;
}
