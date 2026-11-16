/**
 * The command palette's task lookup: typing a code the chats use (`#82`, `ppm/82`, any case) puts
 * that task first, so Enter opens it. `#82` means the active project's task 82 when it has one.
 * Kept apart from `command-palette.tsx`, which only prepends what this returns.
 */
import { useEffect, useMemo, useState } from "react";
import { ListTodo } from "@/lib/icons";
import { lookupTasksByCode } from "@/lib/ppm-tasks/task-code-lookup";
import { openTask } from "@/lib/ppm-tasks/open-task";
import { parseTaskCodeQuery, taskCode } from "../../../shared/ppm-tasks-refs";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { CommandItem } from "./command-palette-items";

/** How many tasks a bare `#82` may list when several projects have one. */
const MAX_TASK_CODE_RESULTS = 5;

/** A task as a palette row: "#82 Fix login", hinted with its project and status. */
export function taskCodeItem(task: TaskDto, activeProject: string | null, onClose: () => void): CommandItem {
  return {
    id: `task:${task.id}`,
    label: `${taskCode(task, activeProject)} ${task.title}`,
    hint: `Task · ${task.project} · ${task.statusName}`,
    icon: ListTodo,
    group: "action",
    action: () => { openTask(task, { keep: true }); onClose(); },
  };
}

/**
 * The rows a code in `query` finds, and whether the lookup for what is typed now is still out:
 * Enter waits for it, or `#82` typed and entered at once would fall through to "Ask AI".
 */
export function useTaskCodeCommands(query: string, activeProject: string | null, onClose: () => void): { items: CommandItem[]; pending: boolean } {
  const isCode = !!parseTaskCodeQuery(query);
  const [found, setFound] = useState<{ query: string; tasks: TaskDto[] } | null>(null);
  useEffect(() => {
    if (!isCode) return;
    let live = true;
    const timer = setTimeout(() => {
      void lookupTasksByCode(query, activeProject, { anywhere: true }).then((tasks) => { if (live) setFound({ query, tasks: tasks ?? [] }); });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [isCode, query, activeProject]);
  return useMemo(() => {
    // Only the answer to what is typed now: a stale one would open the wrong task on Enter.
    if (!isCode) return { items: [], pending: false };
    if (found?.query !== query) return { items: [], pending: true };
    return { items: found.tasks.slice(0, MAX_TASK_CODE_RESULTS).map((t) => taskCodeItem(t, activeProject, onClose)), pending: false };
  }, [isCode, found, query, activeProject, onClose]);
}
