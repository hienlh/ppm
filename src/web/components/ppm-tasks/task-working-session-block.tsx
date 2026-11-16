/**
 * The working-session block at the top of a task's properties: the chat doing the task, its live
 * state, what the handed-off work check last found ("stalled 40 min", "finished, no report", with
 * when progress was last seen), and Open chat. With no chat it offers Start chat; with one it also
 * offers a new chat, which the caller confirms before it replaces the current one.
 */
import { Bot, ExternalLink, MessageCircle, Plus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sessionChipView } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { ageShort, whenShort } from "@/lib/ppm-tasks/task-format";
import type { TaskCheckSummary, TaskWorkingSession } from "../../../shared/ppm-tasks-api";

const STATE_LABEL: Record<string, string> = {
  run: "Running", mgr: "Manager", idle: "Idle", need: "Waiting on you", stalled: "Stalled", finished: "Finished, no report", gone: "Deleted",
};

export function checkTooltip(check: TaskCheckSummary | null | undefined): string | undefined {
  if (!check) return undefined;
  return check.lastProgressAt ? `Progress last seen ${whenShort(check.lastProgressAt)}` : "No progress seen since it was handed off";
}

export interface TaskWorkingSessionBlockProps {
  working: TaskWorkingSession;
  check: TaskCheckSummary | null;
  onOpen(sessionId: string): void;
  onStartChat(): void;
}

export function TaskWorkingSessionBlock({ working, check, onOpen, onStartChat }: TaskWorkingSessionBlockProps) {
  const view = sessionChipView(working, check, Date.now());
  if (working.kind === "start_chat") {
    return (
      <div className="rounded-lg border border-dashed border-border p-3" data-working-session="none">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Working session</p>
        <p className="mt-1 text-[13px] text-text-2">No chat works on this task and the project has no manager chat.</p>
        <Button size="sm" className="mt-2.5 w-full" onClick={onStartChat}><Plus className="size-3.5" />Start chat</Button>
      </div>
    );
  }
  const s = working.session;
  const isManager = working.kind === "manager";
  const name = isManager ? "Manager" : s.title?.trim() || "Chat";
  // A check finding (stalled, finished without reporting) wins; otherwise the chat's own state.
  const live = view.tone === "stalled" || view.tone === "finished" || view.tone === "gone" ? STATE_LABEL[view.tone]!
    : s.state === "running" ? "Running" : s.state === "waiting_card" ? "Waiting on you" : s.state === "unknown" ? "State unknown" : "Idle";
  const tone = view.tone === "stalled" ? "text-warning" : view.tone === "finished" || view.tone === "need" ? "text-error" : view.tone === "run" || s.state === "running" ? "text-success" : "text-text-2";
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-3" data-working-session={view.tone}>
      <div className="flex gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-wash text-primary">
          {isManager ? <Bot className="size-4" /> : <MessageCircle className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Working session</p>
          <p className="truncate text-[13.5px] font-semibold text-text" title={s.title ?? undefined}>{isManager ? `Manager${s.title ? ` · ${s.title}` : ""}` : name}</p>
          <p className={cn("mt-0.5 text-xs font-medium", tone)} title={checkTooltip(check)}>
            {live}{view.tone === "stalled" && view.detail ? ` · ${view.detail.replace(/^stalled /, "")}` : ""}
            {s.runningSince && s.state === "running" ? <span className="font-normal text-text-3"> · {ageShort(s.runningSince)} into this turn</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-text-3">{isManager ? "The project's manager chat · not handed to a child chat" : "Handed to this chat"}</p>
        </div>
      </div>
      <Button size="sm" className="mt-2.5 w-full" disabled={s.state === "gone"} onClick={() => onOpen(s.sessionId)}>
        <ExternalLink className="size-3.5" />Open chat
      </Button>
      <button type="button" onClick={onStartChat} className="mt-1.5 w-full rounded-md py-1 text-xs text-text-3 hover:bg-surface-hover hover:text-text">
        Start a new chat for this task
      </button>
    </div>
  );
}
