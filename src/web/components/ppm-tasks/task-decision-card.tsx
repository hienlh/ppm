/**
 * A Decision task's options (variant-3 screen 01, all-projects detail): A, B, … each with "Choose".
 * Choosing calls the server's `decide` and nothing else: the server records the choice and sends
 * it word for word to the working chat (the manager when the task is not handed off), with or
 * without a browser open. Where it went, and "Send again" when it was recorded but not sent, are
 * the caller's toasts (`useTaskWrite().decide`). The options themselves are edited one per line.
 */
import { useState } from "react";
import { Check, Pencil, Scale } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PPM_TASK_LIMITS } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { CardTextButton, PlainTextEditor, TaskCard } from "./task-card";

export interface TaskDecisionCardProps {
  task: TaskDto;
  busy?: boolean;
  onChoose(optionId: string): void;
  onEditOptions(input: { question: string | null; options: string[] }): void;
}

const letter = (id: string, i: number) => (/^[a-z]$/i.test(id) ? id.toUpperCase() : String.fromCharCode(65 + i));

function sentTo(task: TaskDto): string {
  const w = task.workingSession;
  if (w.kind === "manager") return "the manager chat";
  if (w.kind === "session") return `"${w.session.title?.trim() || "the working chat"}"`;
  return "the working chat (start one first)";
}

export function TaskDecisionCard({ task, busy, onChoose, onEditOptions }: TaskDecisionCardProps) {
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
    <TaskCard tone="decision" data-task-card="decision"
      title={<span className="inline-flex min-w-0 items-center gap-1.5"><Scale aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{d?.question?.trim() || "Options"}</span></span>}
      aside={!editing && <CardTextButton onClick={() => setEditing(true)}><Pencil className="size-3" />Edit</CardTextButton>}>
      {editing ? (
        <PlainTextEditor value={options.map((o) => o.label).join("\n")} label="Options, one per line" rows={4}
          placeholder={"One option per line\nFor example: Qualifying earnings, as in October"} onSave={save} onCancel={() => setEditing(false)} />
      ) : options.length === 0 ? (
        <p className="text-[13px] text-text-3">No options yet. Add them here, or ask the manager to prepare them.</p>
      ) : (
        <ol className="-mx-3 divide-y divide-border-soft">
          {options.map((o, i) => {
            const isChosen = chosen?.optionId === o.id;
            return (
              <li key={o.id} className={cn("flex items-start gap-2.5 px-3 py-2.5", chosen && !isChosen && "opacity-60")} data-decision-option={o.id}>
                <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-semibold",
                  isChosen ? "bg-success text-white" : "bg-accent-2/15 text-accent-2")}>{isChosen ? <Check className="size-3" /> : letter(o.id, i)}</span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-text">{o.label}</p>
                <Button size="sm" variant={isChosen ? "outline" : "default"} disabled={busy} onClick={() => onChoose(o.id)} className="shrink-0">
                  {isChosen ? "Send again" : `Choose ${letter(o.id, i)}`}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 text-xs text-text-3">
        {chosen
          ? `Chosen by ${chosen.by} · sent to ${sentTo(task)}. Choosing again sends the new choice.`
          : `Your choice is sent to ${sentTo(task)} word for word and recorded in history.`}
      </p>
    </TaskCard>
  );
}
