/**
 * The task rows two "Waiting on you" cards carry:
 * - the handed-off work card (a chat stalled, or finished without reporting, and the manager could
 *   not be woken): each task with "Open chat" on the chat working on it;
 * - "PPM Assistant made N task changes while you were away": each change with a real Undo, which
 *   undoes that history row exactly as Undo in the task's History does.
 * Opening a chat goes through the card's usual window (`openManagerChat`), under the chat's own
 * provider, read from the task.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Undo2 } from "@/lib/icons";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import { offerTaskManagerPrompt } from "@/components/ppm-tasks/task-manager-prompt-toast";
import type { AssistantCardPayload } from "../../../../shared/assistant-cards";
import { attachTaskChip, type ComposerTaskChip } from "@/lib/ppm-tasks/composer-task-chip";
import { openManagerChat } from "../open-manager-chat";

/** A row action: never full width (the card's own buttons are on a phone), 44px tall below md. */
function RowButton({ children, onClick, disabled, title }: { children: React.ReactNode; onClick(): void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 md:h-8 md:text-xs">
      {children}
    </button>
  );
}

type HandedOff = NonNullable<AssistantCardPayload["tasks"]>[number];
type Change = NonNullable<AssistantCardPayload["taskChanges"]>[number];

/**
 * Opens the chat a handed-off task works in, under that chat's provider, with the task as a chip
 * in its composer so the next message says which task it is about.
 */
export async function openHandedOffChat(projectName: string, item: HandedOff): Promise<void> {
  let providerId = "claude";
  let title = item.ref;
  let chip: ComposerTaskChip | null = null;
  try {
    const { task } = await ppmTasksClient.get(item.taskId);
    const w = task.workingSession;
    if (w.kind !== "start_chat" && w.session.sessionId === item.sessionId) {
      providerId = w.session.providerId ?? providerId;
      title = w.session.title?.trim() || title;
    }
    chip = { taskId: task.id, number: task.number, ref: task.ref, title: task.title, project: task.project };
  } catch { /* the task is gone or off: the chat still opens, as Claude, with no chip */ }
  await openManagerChat({ projectName, sessionId: item.sessionId, chat: { title, providerId } });
  if (chip) void attachTaskChip(item.sessionId, chip);
}

export function CardHandedOffTasks({ projectName, tasks }: { projectName: string | null; tasks: readonly HandedOff[] }) {
  if (!tasks.length) return null;
  return (
    <ul className="space-y-1.5" data-card-tasks="">
      {tasks.map((t) => (
        <li key={`${t.taskId}:${t.sessionId}`} className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-primary">{t.ref}</span>
          <RowButton disabled={!projectName} title={`Open the chat working on ${t.ref}`}
            onClick={() => { if (projectName) void openHandedOffChat(projectName, t); }}>
            <ExternalLink className="size-3.5" />Open chat
          </RowButton>
        </li>
      ))}
    </ul>
  );
}

function ChangeRow({ change }: { change: Change }) {
  const [state, setState] = useState<"idle" | "busy" | "undone">("idle");
  const undo = async () => {
    if (change.historyId === null) return;
    setState("busy");
    try {
      const answer = await ppmTasksClient.undo(change.historyId);
      setState("undone");
      toast.success(`Undone: ${change.summary}`);
      offerTaskManagerPrompt(answer);
    } catch (e) {
      const message = (e as Error).message || "Could not undo";
      // Undone already (here, in the task's History, or by asking the Assistant): say so and stop offering it.
      if (/already undone/i.test(message)) setState("undone");
      else setState("idle");
      toast.error(message);
    }
  };
  return (
    <li className="flex items-start gap-2 py-1.5" data-card-task-change={change.historyId ?? "settings"} data-undone={state === "undone" || undefined}>
      <p className={`min-w-0 flex-1 break-words text-[13px] ${state === "undone" ? "text-text-subtle line-through" : "text-text-secondary"}`}>{change.summary}</p>
      {change.historyId === null ? (
        <span className="shrink-0 text-xs text-text-subtle">settings · cannot be undone</span>
      ) : state === "undone" ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-subtle"><Check className="size-3.5" />Undone</span>
      ) : (
        <RowButton disabled={state === "busy"} onClick={() => void undo()} title={`Undo #${change.historyId}`}>
          <Undo2 className="size-3.5" />Undo
        </RowButton>
      )}
    </li>
  );
}

export function CardTaskChanges({ changes }: { changes: readonly Change[] }) {
  if (!changes.length) return null;
  return (
    <ul className="divide-y divide-border rounded-md border border-border bg-panel-2 px-2.5" data-card-task-changes="">
      {changes.map((c, i) => <ChangeRow key={c.historyId ?? `s${i}`} change={c} />)}
    </ul>
  );
}
