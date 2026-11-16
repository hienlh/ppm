/**
 * A PPM task as a chip: "Task #12 · Fix login".
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

/** As tall as a turn chip, so the two kinds line up in one row. */
const CHIP_BOX = "inline-flex h-[44px] max-w-[18rem] items-center gap-1.5 rounded-md border border-primary/30 bg-accent-wash text-xs text-text md:h-7";

/** The composer's chips, above the input. */
export function ComposerTaskChipRow({ chips, onRemove }: { chips: readonly ComposerTaskChip[]; onRemove: (taskId: string) => void }) {
  return (
    <div className="px-2 pt-2 md:px-4">
      <div className="flex flex-wrap gap-2" data-composer-task-refs="">
        {chips.map((chip) => (
          <span key={chip.taskId} data-task-chip={chip.taskId} title={`${chip.ref}: ${chip.title}. This message will say it is about this task.`}
            className={cn(CHIP_BOX, "pl-2")}>
            <ListTodo className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{taskChipLabel(chip)}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(chip.taskId); }}
              aria-label={`Remove task #${chip.number}`}
              title="Remove"
              className="flex size-[44px] shrink-0 items-center justify-center rounded-md text-text-subtle hover:text-text-primary md:size-7"
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
export function TaskRefChipRow({ refs }: { refs: readonly TaskReference[] }) {
  return (
    <div className="mb-1 flex flex-wrap gap-1.5" data-task-refs="">
      {refs.map((ref) => (
        <button
          key={ref.taskId}
          type="button"
          data-task-ref={ref.taskId}
          title={`${ref.ref}: ${ref.title} · ${ref.status}. Open the task.`}
          onClick={(e) => { e.stopPropagation(); openTaskTab({ id: ref.taskId, project: ref.projectName, title: ref.title }); }}
          className={cn(CHIP_BOX, "px-2 hover:border-primary/60")}
        >
          <ListTodo className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 truncate">{taskChipLabel(ref)}</span>
        </button>
      ))}
    </div>
  );
}
