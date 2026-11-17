/**
 * The property fields a task's page edits in place, one component each: status (a closed one
 * closes the task), urgency (with why the due date raised it), importance, and a member picker for
 * assignee and waiting on. Each saves on change; the date and text fields save on blur. Their
 * choices (`statusChoices`…) are shared with the chat's quick view (`TaskPeekFields`), whose chips
 * offer exactly the same.
 */
import { cn } from "@/lib/utils";
import { IMPORTANCE_LABEL, URGENCY_LABEL } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { IMPORTANCES, ME_MEMBER_ID, URGENCIES, type TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "./kit/task-status-glyph";

/** A field's select or input: borderless until hovered or focused, 28px. */
export const PROP_SELECT = "h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-[13px] text-text outline-none hover:border-border-soft focus:border-ring focus:bg-surface";

/** A field's label over its control, with an optional note at the right of the label. */
export function TaskProp({ label, children, aside, className }: { label: string; children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <div className="flex items-center text-[11.5px] font-medium text-text-3">{label}<span className="flex-1" />{aside}</div>
      {children}
    </div>
  );
}

export type Member = { id: string; name: string };

/** Who a member field offers: You, then the project's members (archived ones only while picked). */
export function taskPeople(task: Pick<TaskDto, "assigneeMemberId" | "waitingOnMemberId">, members: TaskProjectSettings["members"] | undefined): Member[] {
  const live = (members ?? []).filter((m) => !m.archivedAt || m.id === task.assigneeMemberId || m.id === task.waitingOnMemberId);
  return [{ id: ME_MEMBER_ID, name: "You" }, ...live];
}

/** One option of a property's picker. */
export interface TaskChoice { value: string; label: string }

/**
 * The choices of each property: the page's selects and the quick view's chip menus offer the same.
 * A member field's are "Nobody" (`""`), then the people `taskPeople` answered.
 */
export function statusChoices(task: Pick<TaskDto, "statusId" | "statusName">, statuses: TaskProjectSettings["statuses"] | undefined): TaskChoice[] {
  return (statuses ?? [{ id: task.statusId, name: task.statusName }]).map((s) => ({ value: s.id, label: s.name }));
}

export function urgencyChoices(task: Pick<TaskDto, "urgency" | "urgencyRaised" | "effectiveUrgency">): TaskChoice[] {
  return URGENCIES.map((u) => ({ value: u, label: `${URGENCY_LABEL[u]}${u === task.urgency && task.urgencyRaised ? ` (shown as ${URGENCY_LABEL[task.effectiveUrgency]})` : ""}` }));
}

export function importanceChoices(): TaskChoice[] {
  return IMPORTANCES.map((i) => ({ value: i, label: IMPORTANCE_LABEL[i] }));
}

export function memberChoices(people: readonly Member[]): TaskChoice[] {
  return [{ value: "", label: "Nobody" }, ...people.map((m) => ({ value: m.id, label: m.name }))];
}

const options = (choices: readonly TaskChoice[]) => choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>);

export function TaskStatusField({ task, statuses, onStatus, className }: {
  task: TaskDto; statuses: TaskProjectSettings["statuses"] | undefined; onStatus(statusId: string): void; className?: string;
}) {
  return (
    <TaskProp label="Status" className={className}>
      <label className="flex items-center gap-1.5">
        <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} />
        <select aria-label="Status" className={PROP_SELECT} value={task.statusId} onChange={(e) => onStatus(e.target.value)}>
          {options(statusChoices(task, statuses))}
        </select>
      </label>
    </TaskProp>
  );
}

export function TaskUrgencyField({ task, onPatch, hint = true, className }: { task: TaskDto; onPatch(patch: TaskPatch): void; hint?: boolean; className?: string }) {
  return (
    <TaskProp label="Urgency" className={className} aside={task.urgencyRaised && <span className="rounded bg-accent-wash px-1.5 text-[10.5px] text-primary">auto</span>}>
      <select aria-label="Urgency" className={PROP_SELECT} value={task.urgency} onChange={(e) => onPatch({ urgency: e.target.value as TaskDto["urgency"] })}>
        {options(urgencyChoices(task))}
      </select>
      {hint && task.urgencyRaised && (
        <p className="text-xs text-text-3" data-urgency-hint="">
          Raised from {URGENCY_LABEL[task.urgency]} by the due date. Due {task.dueDate} keeps it at least {URGENCY_LABEL[task.effectiveUrgency]}.
        </p>
      )}
    </TaskProp>
  );
}

export function TaskImportanceField({ task, onPatch, className }: { task: TaskDto; onPatch(patch: TaskPatch): void; className?: string }) {
  return (
    <TaskProp label="Importance" className={className}>
      <select aria-label="Importance" className={PROP_SELECT} value={task.importance} onChange={(e) => onPatch({ importance: e.target.value as TaskDto["importance"] })}>
        {options(importanceChoices())}
      </select>
    </TaskProp>
  );
}

/** Assignee or Waiting on: "Nobody", You, the project's members. */
export function TaskMemberField({ label, value, people, onChange, children, className }: {
  label: "Assignee" | "Waiting on"; value: string | null; people: readonly Member[]; onChange(memberId: string | null): void;
  children?: React.ReactNode; className?: string;
}) {
  return (
    <TaskProp label={label} className={className}>
      <select aria-label={label} className={PROP_SELECT} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        {options(memberChoices(people))}
      </select>
      {children}
    </TaskProp>
  );
}
