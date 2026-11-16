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
import { TASK_TYPES, type TaskPatch } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../shared/ppm-tasks-api";
import { TaskCode } from "./kit/task-code";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { TaskCustomFields } from "./task-custom-fields";
import { TaskTagsEditor } from "./task-tags-editor";
import { TaskDateInput } from "./task-date-input";
import { PROP_SELECT, TaskImportanceField, TaskMemberField, TaskProp, TaskStatusField, TaskUrgencyField, taskPeople } from "./task-property-fields";

const sel = PROP_SELECT;
const Prop = TaskProp;

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
  const people = taskPeople(task, members);

  return (
    <div className="space-y-3.5 text-[13px]" data-task-properties="">
      <TaskStatusField task={task} statuses={settings?.statuses} onStatus={onStatus} />
      <Prop label="Type">
        <select aria-label="Type" className={sel} value={task.type} onChange={(e) => onPatch({ type: e.target.value })}>
          {[...new Set([...TASK_TYPES, task.type])].map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
      </Prop>
      <TaskUrgencyField task={task} onPatch={onPatch} />
      <TaskImportanceField task={task} onPatch={onPatch} />
      <Prop label="Due">
        <TaskDateInput label="Due date" className={sel} value={task.dueDate} onSave={(dueDate) => onPatch({ dueDate })} />
      </Prop>
      <TaskMemberField label="Assignee" value={task.assigneeMemberId} people={people} onChange={(assigneeMemberId) => onPatch({ assigneeMemberId })}>
        {accounts && <p className="truncate text-xs text-text-3" title={accounts}>{accounts}</p>}
      </TaskMemberField>
      <TaskMemberField label="Waiting on" value={task.waitingOnMemberId} people={people} onChange={(waitingOnMemberId) => onPatch({ waitingOnMemberId })}>
        {task.waitingOnMemberId && task.waitingSince && <p className="text-xs text-text-3">since {whenShort(task.waitingSince)} · {ageShort(task.waitingSince)}</p>}
      </TaskMemberField>
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
