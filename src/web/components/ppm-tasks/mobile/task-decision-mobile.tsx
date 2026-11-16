/**
 * A Decision task's options on a phone: the question, then each option as a full-width button at
 * least 44px tall. A tap calls the server's `decide`, which records the choice and sends it word
 * for word to the working chat (the manager when the task is not handed off); where it went, "Send
 * again" when it was recorded but not sent, and Start chat when no chat can take it are the
 * caller's toasts (`useTaskWrite().decide`). The chosen option says so, and tapping it again sends
 * it again. Options are edited one per line, as on a desktop.
 */
import { useState } from "react";
import { Check, Pencil, Scale } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PPM_TASK_LIMITS } from "../../../../shared/ppm-tasks";
import type { TaskDto } from "../../../../shared/ppm-tasks-api";
import { PlainTextEditor } from "../task-card";
import { letter, sentTo } from "../task-decision-card";

export interface TaskDecisionMobileProps {
  task: TaskDto;
  busy?: boolean;
  onChoose(optionId: string): void;
  onEditOptions(input: { question: string | null; options: string[] }): void;
}

export function TaskDecisionMobile({ task, busy, onChoose, onEditOptions }: TaskDecisionMobileProps) {
  const [editing, setEditing] = useState(false);
  const d = task.decision;
  const options = d?.options ?? [];
  const chosen = d?.chosen ?? null;
  const save = (text: string) => {
    setEditing(false);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, PPM_TASK_LIMITS.decisionOptions);
    if (lines.length) onEditOptions({ question: d?.question ?? null, options: lines });
  };
  return (
    <section className="rounded-xl border border-accent-2/40 bg-accent-2/5 p-3" data-task-card="decision">
      <div className="flex items-center gap-2 text-accent-2">
        <Scale aria-hidden className="size-4 shrink-0" />
        <p className="min-w-0 flex-1 text-sm font-semibold">{d?.question?.trim() || "Decide"}</p>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="-mr-1 inline-flex h-11 items-center gap-1 rounded-lg px-2 text-sm text-primary">
            <Pencil className="size-3.5" />Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2">
          <PlainTextEditor value={options.map((o) => o.label).join("\n")} label="Options, one per line" rows={4}
            placeholder="One option per line" onSave={save} onCancel={() => setEditing(false)} />
        </div>
      ) : options.length === 0 ? (
        <p className="mt-2 text-sm text-text-3">No options yet. Add them with Edit, or ask the manager to prepare them.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {options.map((o, i) => {
            const isChosen = chosen?.optionId === o.id;
            return (
              <button key={o.id} type="button" disabled={busy} onClick={() => onChoose(o.id)} data-decision-option={o.id} aria-pressed={isChosen}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-[15px] active:scale-[0.99] disabled:opacity-60",
                  isChosen ? "border-success/50 bg-success/10 text-text" : "border-border bg-panel text-text",
                  chosen && !isChosen && "opacity-70",
                )}>
                <span className={cn("grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold",
                  isChosen ? "bg-success text-white" : "bg-accent-2/15 text-accent-2")}>{isChosen ? <Check className="size-3.5" /> : letter(o.id, i)}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{o.label}</span>
                {isChosen && <span className="shrink-0 text-xs text-text-3">Send again</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-xs text-text-3">
        {chosen
          ? `Chosen by ${chosen.by} · sent to ${sentTo(task)}. Choosing again sends the new choice.`
          : `Your choice is sent to ${sentTo(task)} word for word and recorded in history.`}
      </p>
    </section>
  );
}
