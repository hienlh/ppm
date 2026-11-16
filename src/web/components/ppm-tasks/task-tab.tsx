/**
 * The `task` tab: one task's page, in the grid or in the task's floating window (`openTask`). It
 * reads the task (kept current by the store), the project's task settings, and whether the tab is
 * still a preview; keeps the tab's title in step with the task's ("#12 Fix login"); and renders the
 * page for the viewport.
 *
 * Below `md` the phone page draws the same props (`mobile/task-detail-mobile.tsx`).
 */
import { useEffect } from "react";
import { Loader2 } from "@/lib/icons";
import { usePpmTask } from "@/hooks/use-ppm-tasks";
import { usePpmTaskProjectSettings } from "@/hooks/use-ppm-task-projects";
import { ppmTasksStore } from "@/stores/ppm-tasks-store";
import { useTabStore } from "@/stores/tab-store";
import { syncTaskTabTitle } from "@/lib/ppm-tasks/open-task-tab";
import { watchTaskWindowRects } from "@/lib/ppm-tasks/task-window-rect";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { TaskDetailDesktop, type TaskDetailViewProps } from "./task-detail-desktop";
import { TaskDetailMobile } from "./mobile/task-detail-mobile";

export function TaskTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  const taskId = typeof metadata?.taskId === "string" ? metadata.taskId : null;
  const preview = metadata?.preview === true;
  const { detail, loading, error } = usePpmTask(taskId);
  const project = detail?.task.project ?? (typeof metadata?.projectName === "string" ? metadata.projectName : null);
  const { settings } = usePpmTaskProjectSettings(project);
  const active = useTabStore((s) => !!tabId && s.activeTabId === tabId);
  const DetailView: (p: TaskDetailViewProps) => React.ReactNode = useIsMobile() ? TaskDetailMobile : TaskDetailDesktop;

  useEffect(() => { if (detail) syncTaskTabTitle(tabId, detail.task); }, [detail?.task.title, detail?.task.number, detail?.task.project, tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The list's selection follows the task shown in front.
  useEffect(() => { if (active && taskId) ppmTasksStore.getState().select(taskId); }, [active, taskId]);
  // A task window restored by a reload starts remembering its rect as soon as it is moved.
  useEffect(() => { watchTaskWindowRects(); }, []);

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
