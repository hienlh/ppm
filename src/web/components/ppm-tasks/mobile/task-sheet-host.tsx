/**
 * Mounts the phone's task sheet while `useTaskSheetStore` names a task. The sheet itself is loaded
 * on first use, so the app shell carries only this host and its store. Above `md` there is no
 * sheet: a sheet still open when the screen widens is closed (a desktop opens tasks in windows).
 */
import { lazy, Suspense, useEffect } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTaskSheetStore } from "@/stores/task-sheet-store";

const TaskSheet = lazy(() => import("./task-sheet"));

export function TaskSheetHost() {
  const task = useTaskSheetStore((s) => s.task);
  const close = useTaskSheetStore((s) => s.close);
  const mobile = useIsMobile();
  useEffect(() => { if (!mobile && task) close(); }, [mobile, task, close]);
  if (!task || !mobile) return null;
  return (
    <Suspense fallback={null}>
      <TaskSheet key={task.id} task={task} onClose={close} />
    </Suspense>
  );
}
