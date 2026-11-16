/**
 * A task's phone page in a bottom sheet (`openTask` below `md`). The same page as the task tab,
 * nearly the height of the screen; swipe down, the backdrop or × closes it, and "Full screen" turns
 * it into the tab. Loaded on first use by `TaskSheetHost`.
 */
import { useEffect } from "react";
import { Loader2 } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { usePpmTask } from "@/hooks/use-ppm-tasks";
import { usePpmTaskProjectSettings } from "@/hooks/use-ppm-task-projects";
import { ppmTasksStore } from "@/stores/ppm-tasks-store";
import type { TaskSheetTarget } from "@/stores/task-sheet-store";
import { leaveTaskSheet, openTaskFullScreen } from "@/lib/ppm-tasks/open-task";
import { TaskDetailMobile } from "./task-detail-mobile";

export default function TaskSheet({ task, onClose }: { task: TaskSheetTarget; onClose: () => void }) {
  const { detail, loading, error } = usePpmTask(task.id);
  const { settings } = usePpmTaskProjectSettings(detail?.task.project ?? task.project);
  // The list's selection follows the task shown.
  useEffect(() => { ppmTasksStore.getState().select(task.id); }, [task.id]);

  const expand = () => openTaskFullScreen(detail ? { id: detail.task.id, project: detail.task.project, title: detail.task.title, number: detail.task.number } : task);

  return (
    // The visible height (`--sheet-vh`) plus what the keyboard covers, which the sheet pads back.
    <BottomSheet open onClose={onClose} className="flex h-[calc(var(--sheet-vh)+var(--sheet-kb)-1.5rem)] flex-col overflow-hidden">
      <div className="min-h-0 flex-1" data-task-open-sheet={task.id}>
        {detail ? (
          <TaskDetailMobile detail={detail} settings={settings} preview={false} sheet={{ onClose, onExpand: expand, onLeave: leaveTaskSheet }} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-text-3">
            {loading ? <Loader2 className="size-5 animate-spin" /> : <p>{error ?? "This task could not be read."}</p>}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
