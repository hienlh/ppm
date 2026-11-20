/**
 * The background work a chat's Claude CLI is running right now — shells, agents, monitors,
 * workflows — as its `background_tasks_changed` message reports it (a level signal: each payload
 * replaces the last). Shown in the footer's Tasks tab, each with its own Stop.
 */

export interface LiveBackgroundTask {
  /** The SDK's task id: what `stopTask` takes, and a background shell's `shellId`. */
  taskId: string;
  /** `local_bash`, `local_agent`, `monitor`, `workflow`, … — passed through, never assumed closed. */
  taskType: string;
  description: string;
  subagentType?: string;
  parentTaskId?: string;
}

/**
 * The tasks of one `background_tasks_changed` payload worth showing: well-formed entries only, and
 * none the CLI marks `ambient` (watchers and skip-transcript work, which it says hosts should not
 * count as activity).
 */
export function liveTasksFrom(raw: unknown): LiveBackgroundTask[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveBackgroundTask[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.task_id !== "string" || !r.task_id || r.ambient === true) continue;
    out.push({
      taskId: r.task_id,
      taskType: typeof r.task_type === "string" ? r.task_type : "task",
      description: typeof r.description === "string" ? r.description : "",
      ...(typeof r.subagent_type === "string" && { subagentType: r.subagent_type }),
      ...(typeof r.parent_task_id === "string" && { parentTaskId: r.parent_task_id }),
    });
  }
  return out;
}

/** A word for the kind of task, for its row. */
export function taskKindLabel(t: Pick<LiveBackgroundTask, "taskType" | "subagentType">): string {
  switch (t.taskType) {
    case "local_bash": return "Command";
    case "local_agent": return t.subagentType && t.subagentType !== "general-purpose" ? `Agent · ${t.subagentType}` : "Agent";
    case "monitor": case "local_monitor": return "Monitor";
    case "workflow": case "local_workflow": return "Workflow";
    default: return "Task";
  }
}
