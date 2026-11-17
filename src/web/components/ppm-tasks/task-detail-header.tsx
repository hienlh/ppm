/**
 * The top of a task's page (variant-3 screen 02): `<project> / #<number>`, the preview hint, Copy
 * link, Ask manager and Mark done (Reopen once closed); the code and title, the title edited in
 * place (a click on the code copies it instead); and the chips
 * (status, urgency with its "auto" mark, importance, due, who it waits on).
 */
import { useEffect, useRef, useState } from "react";
import { Check, Link, MessageSquare, RotateCcw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyTaskLink } from "@/lib/ppm-tasks/open-task-tab";
import { taskWaiting } from "@/lib/ppm-tasks/task-format";
import { TaskWaitingLabel } from "./kit/task-waiting-label";
import { TaskStatusGlyph } from "./kit/task-status-glyph";
import { TaskUrgencyPill } from "./kit/task-urgency-pill";
import { TaskImportanceBars } from "./kit/task-importance-bars";
import { TaskDueLabel } from "./kit/task-due-label";
import { TaskTypeBadge } from "./kit/task-type-badge";
import { TaskCode } from "./kit/task-code";
import type { TaskMember } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export interface TaskDetailHeaderProps {
  task: TaskDto;
  members?: readonly TaskMember[];
  preview: boolean;
  hasManager: boolean;
  onRename(title: string): void;
  onAskManager(): void;
  onMarkDone(): void;
  onReopen(): void;
}

export function TaskDetailHeader({ task, members, preview, hasManager, onRename, onAskManager, onMarkDone, onReopen }: TaskDetailHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(task.title); }, [task.title, editing]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const commit = () => {
    setEditing(false);
    const t = draft.replace(/\s+/g, " ").trim();
    if (t && t !== task.title) onRename(t);
  };
  const closed = task.baseGroup === "closed";
  const waiting = taskWaiting(task, members);
  return (
    <header className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-text-2">
        <span data-task-code-pair="" className="flex items-baseline gap-x-2">
          <span data-task-code-title="" className="rounded bg-surface px-1.5 text-xs font-medium text-text">{task.project}</span>
          <span className="text-text-3">/</span>
          <TaskCode task={task} viewProject={task.project} className="text-[13px]" />
        </span>
        {preview && <span className="text-xs text-text-3">Preview · edit to keep the tab</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void copyTaskLink(task)}><Link className="size-3.5" />Copy link</Button>
        {hasManager && <Button size="sm" variant="outline" onClick={onAskManager}><MessageSquare className="size-3.5" />Ask manager</Button>}
        {closed
          ? <Button size="sm" variant="outline" onClick={onReopen}><RotateCcw className="size-3.5" />Reopen</Button>
          : <Button size="sm" onClick={onMarkDone} data-task-mark-done=""><Check className="size-3.5" />Mark done</Button>}
      </div>
      {editing ? (
        <textarea ref={input} aria-label="Task title" rows={2} maxLength={200} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { setDraft(task.title); setEditing(false); } }}
          className="w-full resize-none rounded-md border border-ring bg-surface px-2 py-1 text-xl font-semibold leading-snug text-text outline-none" />
      ) : (
        <h1 className="cursor-text break-words rounded-md text-xl font-semibold leading-snug text-text hover:bg-surface-hover" title="Click to rename"
          onClick={() => setEditing(true)} data-task-title="" data-task-code-pair="">
          <TaskCode task={task} viewProject={task.project} className="mr-1.5 text-[0.7em]" />
          <span data-task-code-title="" className={cn(closed && "text-text-2 line-through decoration-text-3")}>{task.title}</span>
        </h1>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} name={task.statusName} showName />
        {task.type !== "task" && <TaskTypeBadge type={task.type} />}
        <TaskUrgencyPill urgency={task.effectiveUrgency} raised={task.urgencyRaised} />
        <TaskImportanceBars importance={task.importance} />
        <TaskDueLabel dueDate={task.dueDate} />
        {waiting && <TaskWaitingLabel detail={waiting} className="text-xs" />}
      </div>
    </header>
  );
}
