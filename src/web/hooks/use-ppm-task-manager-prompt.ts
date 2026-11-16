/**
 * "Tell the manager now?" after the user changes tasks of a project with a manager chat. The views
 * call `offer` with each write's answer; a burst of edits (a drag, several fields in a row) asks
 * once, `ASK_AFTER_MS` after the last of them. Yes wakes the manager with one turn; No (or a wake
 * PPM refuses) leaves the news for the manager's next turn. P5 shows the question as a dialog, P6
 * as a bottom sheet; both read `asking` and call `answer`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import type { NotifyManagerResponse, TaskWriteResponse } from "../../shared/ppm-tasks-api";

export const ASK_AFTER_MS = 1_500;

/** What to tell the user after a yes, from the server's answer. */
export function notifyOutcomeMessage(r: NotifyManagerResponse): string {
  if (r.sent) return "Manager told";
  switch (r.reason) {
    case "nothing_pending": return "Nothing new to tell the manager";
    case "no_manager": return "This project has no manager chat";
    case "budget": return "The manager's message limit is reached: it will see this on its next turn";
    default: return `Could not reach the manager: it will see this on its next turn${r.error ? ` (${r.error})` : ""}`;
  }
}

export function usePpmTaskManagerPrompt() {
  /** The project being asked about; null when nothing is asked. */
  const [asking, setAsking] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const askingRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const queue = useRef<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  const showNext = useCallback(() => {
    if (askingRef.current) return;
    const next = queue.current.shift() ?? null;
    askingRef.current = next;
    setAsking(next);
  }, []);

  /** Call with a write's answer (null when the write was stale: nothing to ask then). */
  const offer = useCallback((answer: Pick<TaskWriteResponse, "managerPrompt"> & { task: { project: string } } | null) => {
    if (!answer?.managerPrompt) return;
    const project = answer.task.project;
    const t = timers.current.get(project);
    if (t) clearTimeout(t);
    timers.current.set(project, setTimeout(() => {
      timers.current.delete(project);
      if (askingRef.current !== project && !queue.current.includes(project)) queue.current.push(project);
      showNext();
    }, ASK_AFTER_MS));
  }, [showNext]);

  const answer = useCallback(async (yes: boolean): Promise<NotifyManagerResponse | null> => {
    const project = asking;
    // A second tap while the first answer is on its way would wake the manager twice.
    if (!project || sendingRef.current) return null;
    let result: NotifyManagerResponse | null = null;
    if (yes) {
      sendingRef.current = true;
      setSending(true);
      try {
        result = await ppmTasksClient.notifyManager(project);
        toast(notifyOutcomeMessage(result));
      } catch (e) {
        toast.error(`Could not reach the manager: ${(e as Error).message}`);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    }
    askingRef.current = null;
    setAsking(null);
    queue.current = queue.current.filter((p) => p !== project);
    showNext();
    return result;
  }, [asking, showNext]);

  return { asking, sending, offer, answer };
}
