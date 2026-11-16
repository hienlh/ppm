/**
 * A PPM task as a chip: its code and title, "#12 Fix login" (`ppm/12` in a chat of another
 * project); a click on the code copies it.
 *
 * The composer shows one after "Open chat" on a task, with a remove button; it rides on the next
 * message as the task's id, and the server writes the task's block from the store. The sent
 * bubble draws the same chip from that block. A tap on the bubble's chip opens the task.
 */
import { ListTodo, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { openTaskTab } from "@/lib/ppm-tasks/open-task-tab";
import { taskChipLabel, type ComposerTaskChip } from "@/lib/ppm-tasks/composer-task-chip-logic";
import type { TaskReference } from "../../../shared/chat-task-ref";
import { TaskCode } from "@/components/ppm-tasks/kit/task-code";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";

/**
 * A chip with text: 28px, 26px on a phone (`TEXT_CONTROL_HEIGHT`, docs/design-guidelines.md rule 3,
 * the chip row above the composer); there is no 44px minimum. `min-h-0!` keeps a card that grows
 * every button inside it to thumb size from growing this one.
 */
const CHIP_BOX = cn("inline-flex min-h-0! max-w-[18rem] items-center gap-1.5 rounded-md border border-primary/30 bg-accent-wash text-xs text-text", TEXT_CONTROL_HEIGHT);

/** The composer's chips, above the input. `currentProject` is the chat's: its own tasks read `#12`. */
export function ComposerTaskChipRow({ chips, currentProject, onRemove }: { chips: readonly ComposerTaskChip[]; currentProject?: string; onRemove: (taskId: string) => void }) {
  return (
    <div className="px-2 pt-2 md:px-4">
      <div className="flex flex-wrap gap-2" data-composer-task-refs="">
        {chips.map((chip) => (
          <span key={chip.taskId} data-task-chip={chip.taskId} title={`${taskChipLabel(chip, currentProject)}. This message will say it is about this task.`}
            className={cn(CHIP_BOX, "pl-2")}>
            <ListTodo className="size-3.5 shrink-0 text-primary" />
            <span data-task-code-pair="" className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <TaskCode task={chip} viewProject={currentProject ?? null} className="text-[11.5px]" />
              <span data-task-code-title="" className="min-w-0 flex-1 truncate">{chip.title}</span>
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(chip.taskId); }}
              aria-label={`Remove task #${chip.number}`}
              title="Remove"
              data-task-chip-remove=""
              className="flex size-6 min-h-0! shrink-0 items-center justify-center rounded-md text-text-subtle hover:text-text-primary max-md:size-[22px]"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The sent message's chips, drawn from its own block: no request, the same size on every render. */
export function TaskRefChipRow({ refs, currentProject }: { refs: readonly TaskReference[]; currentProject?: string }) {
  return (
    <div className="mb-1 flex flex-wrap gap-1.5" data-task-refs="">
      {refs.map((ref) => (
        <button
          key={ref.taskId}
          type="button"
          data-task-ref={ref.taskId}
          title={`${taskChipLabel({ ...ref, project: ref.projectName }, currentProject)} · ${ref.status}. Open the task.`}
          onClick={(e) => { e.stopPropagation(); openTaskTab({ id: ref.taskId, project: ref.projectName, title: ref.title, number: ref.number }); }}
          className={cn(CHIP_BOX, "px-2 hover:border-primary/60")}
        >
          <ListTodo className="size-3.5 shrink-0 text-primary" />
          <span data-task-code-pair="" className="flex min-w-0 items-baseline gap-1.5">
            <TaskCode task={{ number: ref.number, project: ref.projectName }} viewProject={currentProject ?? null} nested inRow className="text-[11.5px]" />
            <span data-task-code-title="" className="min-w-0 truncate">{ref.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
