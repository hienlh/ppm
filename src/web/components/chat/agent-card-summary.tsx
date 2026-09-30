/**
 * The Agent/Task card's one-line row in chat: description (or teammate handle),
 * step count, current step, status icon, and a tap that opens the live session
 * window/sheet — no inline expansion, no long-press menu, tap only.
 *
 * `usePrefersCoarsePointer` (not `useIsMobile`) is what gates the 44 px minimum:
 * a touch-capable desktop/tablet needs the bigger target just as much as a
 * phone, and a mouse on a narrow desktop pane does not.
 */
import { Bot, ChevronRight, Loader2, CheckCircle2, XCircle, Users } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { formatStepCount } from "@/lib/agent-step-summary";

export type AgentCardStatus = "running" | "done" | "error";

export interface AgentCardSummaryProps {
  /** Teammate handle, when the card is addressable via SendMessage — leads the row. */
  handle: string | null;
  /** input.description/prompt, shown when there is no handle. */
  description: string;
  stepCount: number;
  lastStep?: string;
  status: AgentCardStatus;
  /** Mirrors the pre-existing "running…" chip for a launched-but-unconfirmed background agent —
   *  distinct from `status === "running"`, which also covers an ordinary still-executing call. */
  bgRunning?: boolean;
  onOpen: () => void;
}

export function AgentCardSummary({
  handle, description, stepCount, lastStep, status, bgRunning, onOpen,
}: AgentCardSummaryProps) {
  const coarse = usePrefersCoarsePointer();
  const StatusIcon = status === "error" ? XCircle : status === "done" ? CheckCircle2 : Loader2;
  const statusCls = status === "error" ? "text-error" : status === "done" ? "text-success" : "text-primary animate-spin";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[11px] border border-border bg-panel px-2.5 text-left text-xs",
        "transition-colors hover:bg-panel-2/40",
        coarse ? "min-h-[44px] py-2" : "py-2",
      )}
      title={handle ? `Open ${handle}'s session` : "Open agent session"}
    >
      <span className={cn(
        "inline-flex items-center justify-center size-6 rounded-[7px] shrink-0",
        handle ? "bg-accent-2/15 text-accent-2" : "bg-accent-wash text-primary",
      )}>
        {handle ? <Users className="size-3.5" /> : <Bot className="size-3.5" />}
      </span>

      <span className="min-w-0 flex-1 truncate">
        {handle
          ? <span className="font-medium text-text-primary">{handle}</span>
          : <span className="font-medium text-text">{description || "Agent"}</span>}
        {!!lastStep && (
          <span className="text-text-subtle"> · {lastStep}</span>
        )}
      </span>

      <span className="ml-auto flex items-center gap-2 shrink-0 text-text-3">
        {bgRunning && <span className="text-[10px] text-primary">running…</span>}
        {stepCount > 0 && <span className="font-mono text-[10px]">{formatStepCount(stepCount)}</span>}
        <StatusIcon className={cn("size-3.5", statusCls)} />
        <ChevronRight className="size-3" />
      </span>
    </button>
  );
}
