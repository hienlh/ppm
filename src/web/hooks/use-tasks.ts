/** Fetch task state for a chat session from the BE (rebuilt from the full JSONL). */
import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import type { TaskItem } from "../../services/task-status-aggregator";

/**
 * Fetches `TaskItem[]` from `GET /chat/sessions/:id/tasks`. Re-fetches (debounced) whenever
 * `refetchKey` changes — caller passes the count of Task* events so a new Task tool call
 * triggers a refresh. Disabled (returns []) when there are no tasks / no session.
 */
export function useTasks(
  projectName: string | undefined,
  sessionId: string | undefined,
  enabled: boolean,
  refetchKey: number,
): TaskItem[] {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !projectName || !sessionId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .get<TaskItem[]>(
          `/api/project/${encodeURIComponent(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/tasks`,
        )
        .then((t) => { if (!cancelled) setTasks(t); }) // guard against a prior session's late response
        .catch(() => {/* keep stale on transient errors */});
    }, 300);
    return () => { cancelled = true; if (timer.current) clearTimeout(timer.current); };
  }, [projectName, sessionId, enabled, refetchKey]);

  return tasks;
}
