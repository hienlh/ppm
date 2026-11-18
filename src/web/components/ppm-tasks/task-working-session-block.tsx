/**
 * The working-session block at the top of a task's properties, headed with the task's code: the chat doing the task, its live
 * state, what the handed-off work check last found ("stalled 40 min", "finished, no report", with
 * when progress was last seen), and Open chat. With no chat it offers Start chat; with one it also
 * offers a new chat, which the caller confirms before it replaces the current one.
 *
 * Open chat is for a chat the task was handed to. When the manager chat itself works on the task,
 * opening it is Ask manager's job: the block shows Ask manager instead when the page gives it one
 * (`onAskManager`, the phone, whose page has no other), and no button when the page has its own (the
 * desktop header), so two buttons never open the same chat side by side.
 */
import { Bot, ExternalLink, MessageCircle, MessageSquare, Plus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sessionChipView } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { ageShort, whenShort } from "@/lib/ppm-tasks/task-format";
import { TaskCode } from "./kit/task-code";
import type { TaskCheckSummary, TaskWorkingSession } from "../../../shared/ppm-tasks-api";

const STATE_LABEL: Record<string, string> = {
  run: "Running", mgr: "Manager", idle: "Idle", need: "Waiting on you", stalled: "Stalled", finished: "Finished, no report", gone: "Deleted",
};

export function checkTooltip(check: TaskCheckSummary | null | undefined): string | undefined {
  if (!check) return undefined;
  return check.lastProgressAt ? `Progress last seen ${whenShort(check.lastProgressAt)}` : "No progress seen since it was handed off";
}

export interface TaskWorkingSessionBlockProps {
  /** The task the block belongs to: its code sits beside the heading. */
  task: { number: number; project: string };
  working: TaskWorkingSession;
  check: TaskCheckSummary | null;
  onOpen(sessionId: string): void;
  onStartChat(): void;
  /** Ask manager, when this block is where the page offers it (the project has a manager chat). */
  onAskManager?: () => void;
  /** The project's manager chat: a task handed to it by id is worked on by the manager all the same. */
  managerSessionId?: string | null;
}

/** "WORKING SESSION #82": the heading names the task, so a chat that says "#82" can be matched here. */
function Heading({ task }: { task: TaskWorkingSessionBlockProps["task"] }) {
  return (
    <p data-task-code-pair="" className="flex min-w-0 items-baseline gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">
      <span data-task-code-title="" className="min-w-0 truncate">Working session</span>
      <TaskCode task={task} viewProject={task.project} className="normal-case text-[11.5px]" />
    </p>
  );
}

export function TaskWorkingSessionBlock({ task, working, check, onOpen, onStartChat, onAskManager, managerSessionId }: TaskWorkingSessionBlockProps) {
  const view = sessionChipView(working, check, Date.now());
  if (working.kind === "start_chat") {
    return (
      <div className="rounded-lg border border-dashed border-border p-3" data-working-session="none">
        <Heading task={task} />
        <p className="mt-1 text-[13px] text-text-2">No chat works on this task and the project has no manager chat.</p>
        <Button size="sm" className="mt-2.5 w-full" onClick={onStartChat}><Plus className="size-3.5" />Start chat</Button>
      </div>
    );
  }
  const s = working.session;
  const isManager = working.kind === "manager" || (!!managerSessionId && s.sessionId === managerSessionId);
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
          <Heading task={task} />
          <p className="truncate text-[13.5px] font-semibold text-text" title={s.title ?? undefined}>{isManager ? `Manager${s.title ? ` · ${s.title}` : ""}` : name}</p>
          <p className={cn("mt-0.5 text-xs font-medium", tone)} title={checkTooltip(check)}>
            {live}{view.tone === "stalled" && view.detail ? ` · ${view.detail.replace(/^stalled /, "")}` : ""}
            {s.runningSince && s.state === "running" ? <span className="font-normal text-text-3"> · {ageShort(s.runningSince)} into this turn</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-text-3">{isManager ? "The project's manager chat · not handed to a child chat" : "Handed to this chat"}</p>
        </div>
      </div>
      {isManager ? (
        onAskManager && (
          <Button size="sm" className="mt-2.5 w-full" onClick={onAskManager} data-working-ask-manager="">
            <MessageSquare className="size-3.5" />Ask manager
          </Button>
        )
      ) : (
        <>
          <Button size="sm" className="mt-2.5 w-full" disabled={s.state === "gone"} onClick={() => onOpen(s.sessionId)} data-working-open-chat="">
            <ExternalLink className="size-3.5" />Open chat
          </Button>
          {onAskManager && (
            <Button size="sm" variant="outline" className="mt-1.5 w-full" onClick={onAskManager} data-working-ask-manager="">
              <MessageSquare className="size-3.5" />Ask manager
            </Button>
          )}
        </>
      )}
      <button type="button" onClick={onStartChat} className="mt-1.5 w-full rounded-md py-1 text-xs text-text-3 hover:bg-surface-hover hover:text-text">
        Start a new chat for this task
      </button>
    </div>
  );
}
