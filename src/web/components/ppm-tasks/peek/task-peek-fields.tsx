/**
 * The fields the chat's quick view edits: status, urgency, importance, assignee, waiting on, due
 * and the next step. The selects are the task page's own (`task-property-fields.tsx`) and save on
 * change; the due date and the next step save when the field is left, and also when the quick view
 * closes or moves to another task while they hold something unsaved, so nothing typed is lost.
 */
import { cn } from "@/lib/utils";
import { PPM_TASK_LIMITS, type TaskPatch } from "../../../../shared/ppm-tasks";
import type { TaskDto, TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { TaskDateInput } from "../task-date-input";
import { useSavedDraft } from "../use-saved-draft";
import { PROP_SELECT, TaskImportanceField, TaskMemberField, TaskProp, TaskStatusField, TaskUrgencyField, taskPeople } from "../task-property-fields";

/** The phone's fields: tall enough to read and tap, 15px so a focused field does not zoom the page. */
const PHONE_FIELDS = "max-md:[&_select]:h-9 max-md:[&_select]:text-[15px] max-md:[&_input]:h-9 max-md:[&_input]:text-[15px] max-md:[&_textarea]:text-[15px]";

/** The next step as a draft that saves when left or removed (`useSavedDraft`). */
export function TaskNextStepField({ value, onSave }: { value: string | null; onSave(nextStep: string | null): unknown }) {
  const { draft, setDraft, commit } = useSavedDraft({ shown: value ?? "", normalize: (v) => v.trim(), onSave: (v) => onSave(v || null) });
  return (
    <TaskProp label="Next step">
      <textarea aria-label="Next step" rows={2} maxLength={PPM_TASK_LIMITS.nextStep} value={draft} placeholder="What happens next"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        className="block w-full resize-y rounded-md border border-border-soft bg-surface px-1.5 py-1 text-[13px] leading-snug text-text outline-none placeholder:text-text-3 focus:border-ring" />
    </TaskProp>
  );
}

export function TaskPeekFields({ task, settings, onPatch, onStatus, className }: {
  task: TaskDto; settings: TaskProjectSettings | null; onPatch(patch: TaskPatch): unknown; onStatus(statusId: string): void; className?: string;
}) {
  const people = taskPeople(task, settings?.members);
  return (
    <div className={cn("grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]", PHONE_FIELDS, className)} data-task-peek-fields="">
      <TaskStatusField task={task} statuses={settings?.statuses} onStatus={onStatus} className="col-span-2" />
      <TaskUrgencyField task={task} onPatch={onPatch} hint={false} />
      <TaskImportanceField task={task} onPatch={onPatch} />
      <TaskMemberField label="Assignee" value={task.assigneeMemberId} people={people} onChange={(assigneeMemberId) => onPatch({ assigneeMemberId })} />
      <TaskMemberField label="Waiting on" value={task.waitingOnMemberId} people={people} onChange={(waitingOnMemberId) => onPatch({ waitingOnMemberId })} />
      <TaskProp label="Due" className="col-span-2">
        <TaskDateInput label="Due date" className={PROP_SELECT} value={task.dueDate} onSave={(dueDate) => onPatch({ dueDate })} />
      </TaskProp>
      <div className="col-span-2">
        <TaskNextStepField value={task.nextStep} onSave={(nextStep) => onPatch({ nextStep })} />
      </div>
    </div>
  );
}
