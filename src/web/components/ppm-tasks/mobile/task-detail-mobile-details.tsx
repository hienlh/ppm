/**
 * The Details tab of a task on a phone (variant-3 screen 03): title (tap to rename), chips, the
 * Decision options as full-width buttons, the result ("No result yet" when there is none, edited
 * in a sheet), notes with the next step, links with their live state, the working session with
 * Open chat, and a card of rows — child tasks, assignee, waiting on, custom fields, all
 * properties — each opening its editor sheet. The desktop's cards are reused with their buttons
 * grown to 44px.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Hash, Layers, Moon, Users } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { memberName } from "@/lib/ppm-tasks/task-format";
import type { LinkKind, TaskLink, TaskPatch } from "../../../../shared/ppm-tasks";
import type { TaskDetailResponse, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { TaskTypeBadge } from "../kit/task-type-badge";
import { TaskUrgencyPill } from "../kit/task-urgency-pill";
import { TaskImportanceBars } from "../kit/task-importance-bars";
import { TaskDueLabel } from "../kit/task-due-label";
import { TaskResultBlock } from "../kit/task-result-block";
import { TaskNotesCard } from "../task-notes-card";
import { TaskLinksCard } from "../task-links-card";
import { TaskWorkingSessionBlock } from "../task-working-session-block";
import { TaskDecisionMobile } from "./task-decision-mobile";
import type { TaskSheetKind } from "./task-field-editor-sheet";
import { TaskCode } from "../kit/task-code";
import { TaskSnoozeBadge } from "../kit/task-snooze-badge";
import { TaskSnoozeButton } from "../task-snooze-menu";

export interface TaskDetailMobileDetailsProps {
  detail: TaskDetailResponse;
  settings: TaskProjectSettings | null;
  deciding: boolean;
  /** Changes written while the user was away (unattended Assistant turns), not undone. */
  awayChanges: number;
  onPatch(patch: TaskPatch & { decision?: { question?: string | null; options: string[] } }): void;
  onDecide(optionId: string): void;
  onOpenChat(sessionId: string): void;
  /** The working session block's Open chat: the chat opens with this task as a chip. */
  onOpenWorkingChat(sessionId: string): void;
  onStartChat(): void;
  onAddLink(link: { kind: LinkKind; ref: string; label: string | null }): Promise<boolean>;
  onRemoveLink(link: TaskLink): void;
  onSheet(kind: TaskSheetKind): void;
  onShowActivity(): void;
}

/** The desktop cards' small buttons and the working-session block's, grown to thumb size (the chip keeps its own). */
const THUMB_CARDS = "[&_[data-task-card]_button:not([data-session-tone])]:min-h-11 [&_[data-task-card]_button:not([data-session-tone])]:min-w-11 [&_[data-working-session]_button]:min-h-11";

function Row({ icon, children, aside, onClick }: { icon: ReactNode; children: ReactNode; aside?: ReactNode; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-12 w-full items-center gap-3 px-3 text-left text-sm text-text active:bg-surface-hover">
      <span aria-hidden className="text-text-3 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside && <span className="shrink-0 text-xs text-text-3">{aside}</span>}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3" />
    </button>
  );
}

function Title({ task, title, closed, onRename }: { task: { number: number; project: string }; title: string; closed: boolean; onRename(title: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const commit = () => {
    setEditing(false);
    const t = draft.replace(/\s+/g, " ").trim();
    if (t && t !== title) onRename(t);
  };
  if (editing) {
    return <textarea ref={input} aria-label="Task title" rows={3} maxLength={200} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
      className="w-full resize-none rounded-lg border border-ring bg-surface px-2 py-1.5 text-[19px] font-semibold leading-snug text-text outline-none" />;
  }
  // At least 44px tall like every other control on a phone, even when the title fits one line.
  return (
    <h2 role="button" tabIndex={0} aria-label={`Rename: ${title}`} onClick={() => setEditing(true)} onKeyDown={(e) => { if (e.key === "Enter") setEditing(true); }} data-task-title="" className="flex min-h-11 items-center break-words text-[19px] font-semibold leading-snug text-text">
      <span data-task-code-pair="" className="min-w-0 [overflow-wrap:anywhere]">
        <TaskCode task={task} viewProject={task.project} nested className="mr-1.5 text-[13px]" />
        <span data-task-code-title="" className={cn(closed && "text-text-2 line-through decoration-text-3")}>{title}</span>
      </span>
    </h2>
  );
}

export function TaskDetailMobileDetails(p: TaskDetailMobileDetailsProps) {
  const { task, children, linkStates } = p.detail;
  const members = p.settings?.members;
  const assignee = memberName(task.assigneeMemberId, members);
  const waiting = memberName(task.waitingOnMemberId, members);
  const fieldText = (p.settings?.fieldDefs ?? []).map((d) => task.fields[d.key]).filter((v) => v !== null && v !== undefined && v !== "").map(String).join(" · ");
  const done = children.filter((c) => c.baseGroup === "closed").length;
  const handedOff = task.workingSession.kind === "session" && !!task.handedOffAt;

  return (
    <div className={cn("space-y-3 px-4 pb-6 pt-3", THUMB_CARDS)}>
      {p.awayChanges > 0 && (
        <button type="button" onClick={p.onShowActivity} data-task-away=""
          className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-warning/12 px-3 text-left text-sm text-text">
          <Moon aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{p.awayChanges === 1 ? "1 change" : `${p.awayChanges} changes`} made while you were away</span>
          <span className="shrink-0 text-xs text-primary">See activity</span>
        </button>
      )}
      <Title task={task} title={task.title} closed={task.baseGroup === "closed"} onRename={(title) => p.onPatch({ title })} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {task.type !== "task" && <TaskTypeBadge type={task.type} />}
        <TaskUrgencyPill urgency={task.effectiveUrgency} raised={task.urgencyRaised} />
        <TaskImportanceBars importance={task.importance} />
        <TaskDueLabel dueDate={task.dueDate} />
        {task.tags.map((t) => <span key={t} className="rounded bg-surface px-1.5 text-xs text-text-2">{t}</span>)}
        {task.resurfacedToday && <TaskSnoozeBadge task={task} className="text-xs" />}
        <TaskSnoozeButton task={task} onSnooze={(patch) => p.onPatch(patch)} />
      </div>
      {(task.type === "decision" || task.decision) && (
        <TaskDecisionMobile task={task} busy={p.deciding} onChoose={p.onDecide} onEditOptions={(decision) => p.onPatch({ decision })} />
      )}
      {task.result ? (
        <div className="space-y-1" data-task-card="result">
          <TaskResultBlock result={task.result} />
          <button type="button" onClick={() => p.onSheet("result")} className="h-11 px-1 text-sm text-primary">Edit result</button>
        </div>
      ) : (
        <button type="button" onClick={() => p.onSheet("result")} data-task-card="result"
          className="flex min-h-12 w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-sm text-text-3">
          <span className="min-w-0 flex-1">No result yet{handedOff ? " · the working chat is checked until one is recorded" : ""}</span>
          <span className="shrink-0 text-primary">Record</span>
        </button>
      )}
      <TaskNotesCard task={task} onSave={p.onPatch} />
      <TaskLinksCard task={task} linkStates={linkStates} jiraSite={p.detail.jiraSite} onOpenChat={p.onOpenChat} onAdd={p.onAddLink} onRemove={p.onRemoveLink} />
      <TaskWorkingSessionBlock task={task} working={task.workingSession} check={task.check} onOpen={p.onOpenWorkingChat} onStartChat={p.onStartChat} />
      <div className="divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft bg-panel" data-task-summary="">
        <Row icon={<Layers />} aside={children.length ? `${done} of ${children.length}` : "None"} onClick={() => p.onSheet("children")}>Child tasks</Row>
        <Row icon={<Users />} aside="Assignee" onClick={() => p.onSheet("properties")}>{assignee ?? "Nobody"}</Row>
        {waiting && <Row icon={<Users />} aside="Waiting on" onClick={() => p.onSheet("properties")}>{waiting}</Row>}
        <Row icon={<Hash />} onClick={() => p.onSheet("properties")}>{fieldText || "All properties"}</Row>
      </div>
    </div>
  );
}
