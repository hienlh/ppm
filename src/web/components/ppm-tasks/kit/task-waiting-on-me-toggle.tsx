/**
 * The "Waiting on you" filter: a chip that narrows a task list to the open tasks waiting on the
 * user, with how many there are. The Tasks sidebar and the Tasks chip's list both use it, sized
 * like every other chip (`TEXT_CONTROL_HEIGHT`: 28px, 26px on a phone).
 */
import { Hand } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";

export interface TaskWaitingOnMeToggleProps {
  on: boolean;
  /** Open tasks waiting on the user in the list's scope. */
  count: number;
  onToggle(): void;
  className?: string;
}

export function TaskWaitingOnMeToggle({ on, count, onToggle, className }: TaskWaitingOnMeToggleProps) {
  return (
    <button type="button" aria-pressed={on} onClick={onToggle} data-task-waiting-on-me-filter={on ? "on" : "off"}
      title={on ? "Show every task again" : "Show only the tasks waiting on you"}
      className={cn(TEXT_CONTROL_HEIGHT, "inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-xs max-md:px-2",
        on ? "border-accent-wash-border bg-accent-wash font-medium text-primary" : "border-border-soft text-text-2 hover:text-text",
        className)}>
      <Hand aria-hidden className={cn("size-3.5 shrink-0", !on && count > 0 && "text-primary")} />
      <span className="truncate">Waiting on you</span>
      <span className="font-mono text-[10.5px] tabular-nums opacity-80" data-task-waiting-on-me-count="">{count}</span>
    </button>
  );
}
