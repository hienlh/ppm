/**
 * A task's quick view: its code and title, the fields a glance usually ends in changing (status,
 * urgency, importance, assignee, waiting on, due, next step), and two ways on — Open chat (the
 * chat working on the task, with the task as a chip, like the list row's own chip) and the task's
 * full page (a window on a desktop, a tab on a phone).
 *
 * One body for the desktop popover beside the chat's Tasks list (and beside a task chip) and for
 * the phone's page inside the list's own sheet; `layout` decides the header and the buttons.
 * Every write goes through `useTaskWrite`, the task page's own.
 */
import { useCallback } from "react";
import { AppWindow, ChevronLeft, Loader2, Maximize2, MessageCircle, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { usePpmTask } from "@/hooks/use-ppm-tasks";
import { usePpmTaskProjectSettings } from "@/hooks/use-ppm-task-projects";
import { ppmTasksStore } from "@/stores/ppm-tasks-store";
import { sessionChipView } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { openTaskChat, workingProvider, type TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import { PHONE_ICON_CONTROL_SIZE, TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import type { TaskPatch } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { TaskCode } from "../kit/task-code";
import { changeTaskStatus } from "../mobile/task-status-change";
import { useTaskWrite } from "../use-task-write";
import { TaskPeekFields } from "./task-peek-fields";

/** A button with text: 28px, 26px on a phone (docs/design-guidelines.md rule 3). */
const TEXT_BUTTON = cn("inline-flex min-h-0! shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs transition-colors disabled:opacity-50 max-md:px-2 [&_svg]:size-3.5 [&_svg]:shrink-0", TEXT_CONTROL_HEIGHT);
/** An icon button: 24px, 22px on a phone. */
const ICON_BUTTON = cn("inline-flex size-6 min-h-0! min-w-0! shrink-0 items-center justify-center rounded-md text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text [&_svg]:size-3.5", PHONE_ICON_CONTROL_SIZE);

export interface TaskPeekBodyProps {
  /** The task as the opener knows it: shown in the header until the task has been read. */
  target: TaskTabTarget;
  /** `popover`: the desktop's floating panel; `sheet`: a page of a phone's bottom sheet. */
  layout: "popover" | "sheet";
  /** Leaves the quick view for the task's chat (the opener closes what it must). */
  onLeave(): void;
  /** The task's full page: a window on a desktop, a tab on a phone. */
  onOpenPage(task: TaskTabTarget): void;
  /** ‹ back to the list (the phone's sheet). */
  onBack?(): void;
  /** × (the desktop popover). */
  onClose?(): void;
}

export function TaskPeekBody({ target, layout, onLeave, onOpenPage, onBack, onClose }: TaskPeekBodyProps) {
  const { detail, loading, error } = usePpmTask(target.id);
  const task = detail?.task ?? null;
  const { settings } = usePpmTaskProjectSettings(task?.project ?? target.project);
  const write = useTaskWrite();
  const { actions, run } = write;
  // From the task as the store holds it when the write goes out: a field saved on the way out
  // (the next step, the due date) must not carry the revision of a render two writes ago.
  const current = useCallback((t: TaskDto) => ppmTasksStore.getState().details[t.id]?.data?.task ?? t, []);
  const patch = useCallback((p: TaskPatch) => {
    if (!task) return;
    void run(task.id, () => actions.update(current(task), p));
  }, [actions, current, run, task]);
  const setStatus = useCallback((statusId: string) => {
    if (task) changeTaskStatus(write, current(task), statusId, settings?.statuses);
  }, [current, settings, task, write]);

  const page: TaskTabTarget = task ? { id: task.id, project: task.project, title: task.title, number: task.number } : target;
  const chat = task ? sessionChipView(task.workingSession, task.check, Date.now()) : null;
  const openChat = () => {
    if (!task || !chat?.sessionId) return;
    onLeave();
    openTaskChat(task.project, chat.sessionId, workingProvider(task), task);
  };
  const sheet = layout === "sheet";
  const number = task?.number ?? target.number;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-task-peek={target.id} data-task-peek-layout={layout}>
      <div className={cn("flex shrink-0 items-start gap-1.5 border-b border-border-soft", sheet ? "px-3 pb-2 pt-1" : "py-2 pl-3 pr-2")}>
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back to tasks" title="Back to tasks" data-task-peek-back="" className={cn(ICON_BUTTON, "mt-px")}>
            <ChevronLeft />
          </button>
        )}
        <h3 className={cn("min-w-0 flex-1 font-semibold leading-snug text-text", sheet ? "text-[15px]" : "text-[13px]")} data-task-peek-title="">
          <span data-task-code-pair="" className="[overflow-wrap:anywhere]">
            {number !== undefined && <TaskCode task={{ number, project: task?.project ?? target.project }} viewProject={target.project} className="mr-1.5 text-[12px]" />}
            <span data-task-code-title="" className={cn(task?.baseGroup === "closed" && "text-text-2 line-through decoration-text-3")}>{task?.title ?? target.title}</span>
          </span>
        </h3>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" title="Close" data-task-peek-close="" className={ICON_BUTTON}>
            <X />
          </button>
        )}
      </div>
      <div data-task-peek-scroll="" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", sheet ? "px-4 py-3" : "px-3 py-2.5")}>
        <div data-task-peek-content="">
          {task ? (
            <TaskPeekFields key={task.id} task={task} settings={settings} onPatch={patch} onStatus={setStatus} />
          ) : (
            <div className="flex min-h-24 items-center justify-center text-sm text-text-3">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <p>{error ?? "This task could not be read."}</p>}
            </div>
          )}
        </div>
      </div>
      <div className={cn("flex shrink-0 items-center gap-1.5 border-t border-border-soft", sheet ? "px-3 py-2" : "p-2")}>
        <button type="button" onClick={openChat} disabled={!chat?.sessionId || chat.tone === "gone"} title={chat?.title} data-task-peek-chat=""
          className={cn(TEXT_BUTTON, "text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text")}>
          <MessageCircle />Open chat
        </button>
        <button type="button" onClick={() => onOpenPage(page)} data-task-peek-page={sheet ? "full-screen" : "window"}
          className={cn(TEXT_BUTTON, "ml-auto bg-primary font-medium text-primary-foreground can-hover:hover:bg-primary/90")}>
          {sheet ? <><Maximize2 />Full screen</> : <><AppWindow />Open in window</>}
        </button>
      </div>
    </div>
  );
}
