/**
 * Every property of a task, editable in place (variant-3 screen 02, right column): the working
 * session, status (the project's own statuses; a closed one closes the task), type, urgency (with
 * why the due date raised it), importance, due, assignee and its linked accounts, waiting on and
 * since when, project, parent, tags, custom fields, and who created it and where it sits in its cell.
 */
import { cn } from "@/lib/utils";
import { usePpmTask, usePpmTaskHistory } from "@/hooks/use-ppm-tasks";
import { usePpmTasksStore } from "@/stores/ppm-tasks-store";
import { IMPORTANCE_LABEL, URGENCY_LABEL, typeLabel } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { ageShort, whenShort } from "@/lib/ppm-tasks/task-format";
import { cellKey } from "../../../shared/ppm-tasks-order";
import { IMPORTANCES, ME_MEMBER_ID, TASK_TYPES, URGENCIES, type TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "./kit/task-status-glyph";
import { TaskCode } from "./kit/task-code";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { TaskCustomFields } from "./task-custom-fields";
import { TaskTagsEditor } from "./task-tags-editor";
import { TaskDateInput } from "./task-date-input";

const sel = "h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-[13px] text-text outline-none hover:border-border-soft focus:border-ring focus:bg-surface";

function Prop({ label, children, aside }: { label: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center text-[11.5px] font-medium text-text-3">{label}<span className="flex-1" />{aside}</div>
      {children}
    </div>
  );
}

export interface TaskPropertiesPanelProps {
  task: TaskDto;
  settings: TaskProjectSettings | null;
  onPatch(patch: TaskPatch): void;
  onStatus(statusId: string): void;
  onOpenTask(id: string): void;
  onManageFields(): void;
}

export function TaskPropertiesPanel({ task, settings, onPatch, onStatus, onOpenTask, onManageFields }: TaskPropertiesPanelProps) {
  const members = settings?.members ?? [];
  const live = members.filter((m) => !m.archivedAt || m.id === task.assigneeMemberId || m.id === task.waitingOnMemberId);
  const assignee = members.find((m) => m.id === task.assigneeMemberId);
  const accounts = assignee ? [assignee.jiraAccountId && `Jira ${assignee.jiraAccountId}`, assignee.githubLogin && `GitHub @${assignee.githubLogin}`, assignee.slackUserId && `Slack ${assignee.slackUserId}`].filter(Boolean).join(" · ") : "";
  const parent = usePpmTask(task.parentId).detail?.task ?? null;
  const created = usePpmTaskHistory(task.id, "status").items.find((e) => e.kind === "created");
  const order = usePpmTasksStore((s) => {
    for (const e of Object.values(s.lists)) {
      const cell = e.data?.tasks.filter((t) => cellKey(t) === cellKey(task) && t.baseGroup !== "closed") ?? [];
      const at = cell.findIndex((t) => t.id === task.id);
      if (at >= 0) return `${at + 1} of ${cell.length}`;
    }
    return null;
  });
  const people = [{ id: ME_MEMBER_ID, name: "You" }, ...live];

  return (
    <div className="space-y-3.5 text-[13px]" data-task-properties="">
      <Prop label="Status">
        <label className="flex items-center gap-1.5">
          <TaskStatusGlyph baseGroup={task.baseGroup} closedAs={task.closedAs} />
          <select aria-label="Status" className={sel} value={task.statusId} onChange={(e) => onStatus(e.target.value)}>
            {(settings?.statuses ?? [{ id: task.statusId, name: task.statusName }]).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </Prop>
      <Prop label="Type">
        <select aria-label="Type" className={sel} value={task.type} onChange={(e) => onPatch({ type: e.target.value })}>
          {[...new Set([...TASK_TYPES, task.type])].map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
      </Prop>
      <Prop label="Urgency" aside={task.urgencyRaised && <span className="rounded bg-accent-wash px-1.5 text-[10.5px] text-primary">auto</span>}>
        <select aria-label="Urgency" className={sel} value={task.urgency} onChange={(e) => onPatch({ urgency: e.target.value as TaskDto["urgency"] })}>
          {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}{u === task.urgency && task.urgencyRaised ? ` (shown as ${URGENCY_LABEL[task.effectiveUrgency]})` : ""}</option>)}
        </select>
        {task.urgencyRaised && (
          <p className="text-xs text-text-3" data-urgency-hint="">
            Raised from {URGENCY_LABEL[task.urgency]} by the due date. Due {task.dueDate} keeps it at least {URGENCY_LABEL[task.effectiveUrgency]}.
          </p>
        )}
      </Prop>
      <Prop label="Importance">
        <select aria-label="Importance" className={sel} value={task.importance} onChange={(e) => onPatch({ importance: e.target.value as TaskDto["importance"] })}>
          {IMPORTANCES.map((i) => <option key={i} value={i}>{IMPORTANCE_LABEL[i]}</option>)}
        </select>
      </Prop>
      <Prop label="Due">
        <TaskDateInput label="Due date" className={sel} value={task.dueDate} onSave={(dueDate) => onPatch({ dueDate })} />
      </Prop>
      <Prop label="Assignee">
        <select aria-label="Assignee" className={sel} value={task.assigneeMemberId ?? ""} onChange={(e) => onPatch({ assigneeMemberId: e.target.value || null })}>
          <option value="">Nobody</option>
          {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {accounts && <p className="truncate text-xs text-text-3" title={accounts}>{accounts}</p>}
      </Prop>
      <Prop label="Waiting on">
        <select aria-label="Waiting on" className={sel} value={task.waitingOnMemberId ?? ""} onChange={(e) => onPatch({ waitingOnMemberId: e.target.value || null })}>
          <option value="">Nobody</option>
          {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {task.waitingOnMemberId && task.waitingSince && <p className="text-xs text-text-3">since {whenShort(task.waitingSince)} · {ageShort(task.waitingSince)}</p>}
      </Prop>
      <div className="h-px bg-border-soft" />
      <Prop label="Project"><p className="px-1">{task.project}</p></Prop>
      <Prop label="Parent">
        {task.parentId
          ? (
            <button type="button" onClick={() => onOpenTask(task.parentId!)} data-task-parent=""
              className={cn("flex min-h-0! w-full min-w-0 items-center rounded px-1 text-left text-primary [&_[data-task-code-title]]:hover:underline", TEXT_CONTROL_HEIGHT)}>
              <span data-task-code-pair="" className="flex min-w-0 flex-1 items-baseline gap-1">
                {parent && <TaskCode task={parent} viewProject={task.project} nested inRow className="text-[12px]" />}
                <span data-task-code-title="" className="min-w-0 flex-1 truncate">{parent ? parent.title : "Open parent"}</span>
              </span>
            </button>
          )
          : <p className="px-1 text-text-3">None</p>}
      </Prop>
      <Prop label="Tags"><TaskTagsEditor tags={task.tags} onSave={(tags) => onPatch({ tags })} /></Prop>
      <div className="h-px bg-border-soft" />
      <TaskCustomFields project={task.project} defs={settings?.fieldDefs ?? []} values={task.fields}
        onSave={(key, value) => onPatch({ fields: { [key]: value } })} onManage={onManageFields} />
      <p className={cn("border-t border-border-soft pt-2.5 text-xs text-text-3")}>
        Created {created ? `${whenShort(created.at)} by ${created.actor.label}` : whenShort(task.createdAt)}
        {order ? ` · Order ${order} in ${URGENCY_LABEL[task.urgency]} · ${IMPORTANCE_LABEL[task.importance]}` : ""}
      </p>
    </div>
  );
}
