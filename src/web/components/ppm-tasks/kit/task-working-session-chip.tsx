/**
 * The chat doing a task, as a chip on every row and in the detail: its live dot (running, idle,
 * waiting on you), "Manager" when the task is not handed off, "Start chat" when the project has
 * no manager, and the handed-off work check when it found trouble ("stalled 40 min" in amber,
 * "finished, no report" in red). One tap opens the chat. Below `md` the chip is taller and its hit
 * area reaches 44px.
 */
import type { CSSProperties, MouseEvent } from "react";
import { Bot, MessageCircle, Plus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { sessionChipView, type SessionChipTone } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import type { TaskCheckSummary, TaskWorkingSession } from "../../../../shared/ppm-tasks-api";

const DOT: Partial<Record<SessionChipTone, CSSProperties>> = {
  run: { background: "var(--success)", boxShadow: "0 0 0 2.5px color-mix(in srgb, var(--success) 22%, transparent)" },
  mgr: { background: "var(--accent-2)" },
  need: { background: "var(--error)", boxShadow: "0 0 0 2.5px color-mix(in srgb, var(--error) 20%, transparent)" },
  stalled: { background: "var(--warning)" },
  finished: { background: "var(--error)" },
};

const CHIP: Partial<Record<SessionChipTone, string>> = {
  need: "border-error/40 text-text",
  stalled: "border-warning/50 text-text",
  finished: "border-error/40 text-text",
  none: "border-dashed text-text-3",
  gone: "text-text-3 line-through",
};

export interface TaskWorkingSessionChipProps {
  working: TaskWorkingSession;
  check?: TaskCheckSummary | null;
  /** For "stalled N min"; now by default. */
  now?: number;
  onOpen?(sessionId: string): void;
  onStartChat?(): void;
  /** The larger chip of the detail view. */
  large?: boolean;
  className?: string;
}

export function TaskWorkingSessionChip({ working, check, now, onOpen, onStartChat, large = false, className }: TaskWorkingSessionChipProps) {
  const view = sessionChipView(working, check, now ?? Date.now());
  const Icon = view.tone === "none" ? Plus : working.kind === "manager" ? Bot : MessageCircle;
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    if (view.sessionId) onOpen?.(view.sessionId);
    else onStartChat?.();
  };
  const disabled = view.sessionId ? !onOpen || view.tone === "gone" : !onStartChat;
  return (
    <button type="button" onClick={click} disabled={disabled} title={view.title} data-session-tone={view.tone}
      className={cn(
        "relative inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-soft bg-panel align-middle text-text-2",
        "hover:border-border hover:text-text disabled:cursor-default disabled:hover:border-border-soft",
        // The invisible press area is a decision still open (docs/design-guidelines.md rule 3):
        // 9px on a phone keeps the 26px chip's press at the 44px it had when drawn at 28px.
        "after:absolute after:inset-x-0 after:-inset-y-2 max-md:after:-inset-y-[9px] after:content-['']",
        large ? "h-7 max-w-[220px] px-2.5 text-[12.5px]" : "h-[22px] max-w-[170px] px-2 text-[11.5px] max-md:h-[26px] max-md:min-w-11 max-md:text-[12.5px]",
        CHIP[view.tone], className,
      )}>
      {DOT[view.tone]
        ? <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={DOT[view.tone]} />
        : <Icon aria-hidden className={cn("size-3 shrink-0 text-text-3", working.kind === "manager" && "text-accent-2")} />}
      <span className="min-w-0 truncate">{view.label}</span>
      {view.detail ? (
        <span className={cn("shrink-0", view.tone === "stalled" && "text-warning", (view.tone === "finished" || view.tone === "need") && "text-error")}>
          · {view.detail}
        </span>
      ) : null}
    </button>
  );
}
