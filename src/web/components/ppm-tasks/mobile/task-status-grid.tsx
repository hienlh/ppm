/**
 * The project's own statuses as big buttons, three to a row (variant-3 screen 03, "Move to ·
 * <project> statuses"), the current one highlighted. Shared by the row's long-press sheet and the
 * detail's status sheet. Every button is at least the chip row's 26px, taller for a two-line name.
 */
import { cn } from "@/lib/utils";
import type { TaskProjectSettings } from "../../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "../kit/task-status-glyph";

export interface TaskStatusGridProps {
  project: string;
  statuses: TaskProjectSettings["statuses"];
  currentId: string;
  onPick(statusId: string): void;
}

export function TaskStatusGrid({ project, statuses, currentId, onPick }: TaskStatusGridProps) {
  return (
    <div data-task-status-grid="">
      <p className="px-1 pb-2 text-xs font-medium text-text-3">Move to · {project} statuses</p>
      {statuses.length === 0 ? (
        <p className="px-1 py-2 text-sm text-text-3">Loading statuses…</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {[...statuses].sort((a, b) => a.position - b.position).map((s) => {
            const on = s.id === currentId;
            return (
              <button key={s.id} type="button" aria-pressed={on} data-status-id={s.id} onClick={() => onPick(s.id)}
                className={cn(
                  "flex min-h-[26px] min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1 text-left text-[13px] leading-tight active:scale-[0.98]",
                  on ? "border-accent-wash-border bg-accent-wash font-medium text-text" : "border-border-soft bg-panel text-text-2",
                )}>
                <TaskStatusGlyph baseGroup={s.baseGroup} closedAs={s.closedAs} size="lg" />
                <span className="line-clamp-2 min-w-0 break-words">{s.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
