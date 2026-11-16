/**
 * Child tasks: each with its status glyph, code (`#13`), title, status name and assignee; "1/3" counts the
 * closed ones. A click opens the child; "+ Add child" creates one under this task.
 */
import { Plus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { memberName } from "@/lib/ppm-tasks/task-format";
import type { TaskMember } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { TaskStatusGlyph } from "./kit/task-status-glyph";
import { TaskMemberAvatar } from "./kit/task-member-avatar";
import { TaskCode } from "./kit/task-code";
import { CardTextButton, TaskCard } from "./task-card";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";

export interface TaskChildrenCardProps {
  children: readonly TaskDto[];
  members?: readonly TaskMember[];
  onOpen(child: TaskDto): void;
  onAdd(): void;
}

export function TaskChildrenCard({ children, members, onOpen, onAdd }: TaskChildrenCardProps) {
  const done = children.filter((c) => c.baseGroup === "closed").length;
  return (
    <TaskCard title="Child tasks" count={children.length ? `${done}/${children.length}` : undefined} data-task-card="children"
      aside={<CardTextButton onClick={onAdd}><Plus className="size-3" />Add child</CardTextButton>}>
      {children.length === 0 ? (
        <p className="text-[13px] text-text-3">No child tasks. Split the work into smaller tasks with Add child.</p>
      ) : (
        <ul className="-mx-3 -my-1">
          {children.map((c) => {
            const who = memberName(c.assigneeMemberId, members);
            const closed = c.baseGroup === "closed";
            return (
              <li key={c.id}>
                <button type="button" onClick={() => onOpen(c)} data-task-child={c.id}
                  className={cn("flex min-h-0! w-full min-w-0 items-center gap-2 px-3 text-left hover:bg-surface-hover", TEXT_CONTROL_HEIGHT)}>
                  <TaskStatusGlyph baseGroup={c.baseGroup} closedAs={c.closedAs} name={c.statusName} />
                  <span data-task-code-pair="" className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <TaskCode task={c} viewProject={c.project} nested inRow className="text-[12px]" />
                    <span data-task-code-title="" className={cn("min-w-0 flex-1 truncate text-[13px] text-text", closed && "text-text-3 line-through")}>{c.title}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-text-3">{c.statusName}</span>
                  {who && <TaskMemberAvatar name={who} memberId={c.assigneeMemberId} size="sm" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </TaskCard>
  );
}
