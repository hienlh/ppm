/**
 * The task views' writes, with what every edit needs around it: the task's preview tab is kept,
 * the answer is offered to "Tell the manager now?", a stale write has already been re-read by the
 * store (null back, nothing more to say) and any other failure is a toast. Also the two flows with
 * their own words: a Decision choice (where it went; "Send again" when it was recorded but not
 * sent; Start chat when nobody can take it) and Start chat (confirmed when a chat already works on
 * the task, since the new chat replaces it).
 */
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { usePpmTaskActions } from "@/hooks/use-ppm-tasks";
import { NoSessionError } from "@/lib/ppm-tasks/ppm-tasks-client";
import { keepTaskTab, openTaskChat } from "@/lib/ppm-tasks/open-task-tab";
import { offerTaskManagerPrompt } from "./task-manager-prompt-toast";
import type { ConfirmRequest } from "./task-confirm-dialog";
import type { TaskDecideResponse, TaskDto, TaskWorkingSession, TaskWriteResponse } from "../../../shared/ppm-tasks-api";

/** Where a choice went, in the words the toast uses. */
export function decisionDeliveredMessage(r: Pick<TaskDecideResponse, "delivered" | "task">): string {
  const w = r.task.workingSession;
  const where = w.kind === "manager" ? "the manager chat" : w.kind === "session" ? `"${w.session.title?.trim() || "the working chat"}"` : "the chat";
  switch (r.delivered) {
    case "started": return `Choice sent to ${where}: it started working on it`;
    case "inserted": return `Choice sent to ${where}: it reads it in the turn running now`;
    case "queued": return `Choice sent to ${where}: queued behind its current turn or a card waiting on you`;
    default: return "Choice recorded";
  }
}

/** Whether Start chat would replace a chat that still exists. */
export function startChatReplaces(w: TaskWorkingSession): boolean {
  return w.kind === "session" && w.session.state !== "gone";
}

export function useTaskWrite(confirm?: (req: ConfirmRequest) => Promise<boolean>) {
  const actions = usePpmTaskActions();
  // "Send again" calls the latest `decide`, with the task as the failed answer left it.
  const decideRef = useRef<(task: TaskDto, optionId: string) => Promise<TaskDecideResponse | null>>(async () => null);

  /** Runs one write: keeps the tab, offers the manager prompt, toasts a failure. */
  const run = useCallback(async <T extends TaskWriteResponse>(taskId: string | null, write: () => Promise<T | null>): Promise<T | null> => {
    if (taskId) keepTaskTab(taskId);
    try {
      const answer = await write();
      offerTaskManagerPrompt(answer);
      return answer;
    } catch (e) {
      toast.error((e as Error).message || "Could not save the task");
      return null;
    }
  }, []);

  const startChat = useCallback(async (task: TaskDto): Promise<string | null> => {
    if (startChatReplaces(task.workingSession) && confirm) {
      const w = task.workingSession as Extract<TaskWorkingSession, { kind: "session" }>;
      const yes = await confirm({
        title: "Start a new chat for this task?",
        body: `"${w.session.title?.trim() || "A chat"}" works on ${task.ref} now. The new chat takes its place as the working session; the old chat is kept and keeps running.`,
        confirmLabel: "Start new chat",
      });
      if (!yes) return null;
    }
    const r = await run(task.id, () => actions.startChat(task));
    if (r) openTaskChat(task.project, r.sessionId, "claude");
    return r?.sessionId ?? null;
  }, [actions, confirm, run]);

  const decide = useCallback(async (task: TaskDto, optionId: string): Promise<TaskDecideResponse | null> => {
    keepTaskTab(task.id);
    let r: TaskDecideResponse | null;
    try {
      r = await actions.decide(task, optionId);
    } catch (e) {
      if (e instanceof NoSessionError) {
        toast.error("No chat can take this choice: start a chat for the task first", {
          action: { label: "Start chat", onClick: () => void startChat(task) },
          duration: 15_000,
        });
      } else {
        toast.error((e as Error).message || "Could not record the choice");
      }
      return null;
    }
    if (!r) return null;
    offerTaskManagerPrompt(r);
    if (r.deliveryError || !r.delivered) {
      const answered = r;
      toast.error(`Choice recorded, but not sent: ${r.deliveryError ?? "the chat did not take it"}`, {
        action: { label: "Send again", onClick: () => void decideRef.current(answered.task, optionId) },
        duration: 30_000,
      });
    } else {
      toast.success(decisionDeliveredMessage(r));
    }
    return r;
  }, [actions, startChat]);

  decideRef.current = decide;

  return useMemo(() => ({ actions, run, startChat, decide }), [actions, run, startChat, decide]);
}
