/**
 * Rebuilds task state from chat events (Claude's Task* tools).
 * Pure + dependency-free (no node: imports) so it runs on the BE over
 * parseJsonlTranscript() output and stays trivially unit-testable.
 *
 * Tasks have no id at creation — the id `#N` arrives in the TaskCreate
 * tool_result text, paired to the create via toolUseId.
 */
import type { ChatMessage, ChatEvent } from "../types/chat.ts";

export type TaskStatus = "pending" | "in_progress" | "completed" | "stopped";
export interface TaskItem {
  id: string;
  subject: string;
  status: TaskStatus;
}

const TASK_ID_RE = /Task #(\d+)/;

function toolName(ev: ChatEvent): string | undefined {
  return ev.type === "tool_use" ? ev.tool : undefined;
}
function inputOf(ev: ChatEvent): Record<string, unknown> {
  return ev.type === "tool_use" && ev.input && typeof ev.input === "object"
    ? (ev.input as Record<string, unknown>)
    : {};
}

/**
 * Fold every message's top-level events (subagent-nested events live under
 * `children` and are intentionally excluded) into the current task list.
 */
export function aggregateTasks(messages: ChatMessage[]): TaskItem[] {
  const tasks = new Map<string, TaskItem>();
  // TaskCreate toolUseId -> subject, awaiting the result that carries the id.
  const pendingCreates = new Map<string, string>();

  const upsert = (id: string, patch: Partial<TaskItem>) => {
    const existing = tasks.get(id);
    if (existing) Object.assign(existing, patch);
    else tasks.set(id, { id, subject: "", status: "pending", ...patch });
  };

  for (const msg of messages) {
    if (!msg.events) continue;
    for (const ev of msg.events) {
      if (ev.type === "tool_use") {
        const name = toolName(ev);
        const input = inputOf(ev);
        if (name === "TaskCreate") {
          if (ev.toolUseId) pendingCreates.set(ev.toolUseId, String(input.subject ?? ""));
        } else if (name === "TaskUpdate") {
          const id = String(input.taskId ?? "");
          if (id) {
            // "deleted" removes the task entirely (TaskUpdate's delete status), not a render state.
            if (input.status === "deleted") tasks.delete(id);
            else upsert(id, { status: input.status as TaskStatus });
          }
        } else if (name === "TaskStop") {
          const id = String(input.taskId ?? "");
          if (id) upsert(id, { status: "stopped" });
        }
      } else if (ev.type === "tool_result" && ev.toolUseId && pendingCreates.has(ev.toolUseId)) {
        const subject = pendingCreates.get(ev.toolUseId)!;
        pendingCreates.delete(ev.toolUseId);
        const m = TASK_ID_RE.exec(ev.output ?? "");
        if (!m) continue; // malformed result — ignore defensively
        const id = m[1]!;
        // Seed pending if new; if a placeholder already exists (early update), keep its status
        // and only fill the subject.
        if (tasks.has(id)) upsert(id, { subject });
        else upsert(id, { subject, status: "pending" });
      }
    }
  }

  return [...tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
