/**
 * Pinned, collapsible task tracker for the chat. Shows Claude's Task* state fetched from the BE
 * (rebuilt from the full session JSONL — immune to FE pagination/truncation). Collapsed by
 * default; auto-hides once every task is finished (completed/stopped).
 */
import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, ListTodo } from "lucide-react";
import type { ChatMessage } from "../../../types/chat";
import type { TaskItem, TaskStatus } from "../../../services/task-status-aggregator";
import { useTasks } from "@/hooks/use-tasks";

const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskStop"]);

/** Count Task* tool calls in the visible messages — used to gate + trigger fetches. */
export function countTaskEvents(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (!m.events) continue;
    for (const e of m.events) if (e.type === "tool_use" && TASK_TOOLS.has(e.tool)) n++;
  }
  return n;
}

const GLYPH: Record<TaskStatus, { icon: string; cls: string }> = {
  completed: { icon: "✓", cls: "text-success" },
  in_progress: { icon: "▶", cls: "text-warning" },
  stopped: { icon: "■", cls: "text-text-subtle" },
  pending: { icon: "○", cls: "text-text-subtle" },
};

export function TaskTracker({
  projectName,
  sessionId,
  messages,
}: {
  projectName?: string;
  sessionId?: string;
  messages: ChatMessage[];
}) {
  const taskEventCount = useMemo(() => countTaskEvents(messages), [messages]);
  const tasks = useTasks(projectName, sessionId, taskEventCount > 0, taskEventCount);
  const [collapsed, setCollapsed] = useState(true);

  if (tasks.length === 0) return null;
  // Auto-hide when all work is finished (no pending/in_progress remains).
  const allDone = tasks.every((t) => t.status === "completed" || t.status === "stopped");
  if (allDone) return null;

  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="shrink-0 border-b border-border bg-surface/60 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 w-full px-3 min-h-11 text-left text-xs hover:bg-surface transition-colors"
      >
        {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        <ListTodo className="size-3.5 shrink-0 text-text-secondary" />
        <span className="text-text-primary font-medium">Tasks</span>
        <span className="text-text-subtle">{completed}/{total} done</span>
        <span className="ml-auto h-1 w-16 rounded-full bg-border overflow-hidden shrink-0">
          <span className="block h-full bg-success/70" style={{ width: `${pct}%` }} />
        </span>
      </button>
      {!collapsed && (
        <ul className="px-3 pb-2 space-y-0.5 max-h-48 overflow-y-auto">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const g = GLYPH[task.status] ?? GLYPH.pending;
  const isActive = task.status === "in_progress";
  return (
    <li className={`flex items-start gap-1.5 text-xs rounded px-1 ${isActive ? "bg-warning/10" : ""}`}>
      <span className={`shrink-0 mt-0.5 ${g.cls}`}>{g.icon}</span>
      <span
        className={
          task.status === "completed"
            ? "line-through text-text-subtle"
            : isActive
              ? "text-text-primary font-medium"
              : "text-text-secondary"
        }
      >
        {task.subject || <span className="text-text-subtle italic">#{task.id} (no title)</span>}
      </span>
    </li>
  );
}
