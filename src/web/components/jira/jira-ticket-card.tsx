import { Play, RotateCcw, Square, ExternalLink, Trash2, Loader2, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { JiraWatchResult, JiraResultStatus } from "../../../../src/types/jira";

/** Status dot color */
const DOT_COLORS: Record<JiraResultStatus, string> = {
  pending: "bg-yellow-500",
  queued: "bg-orange-500",
  running: "bg-blue-500 animate-pulse",
  done: "bg-green-500",
  failed: "bg-red-500",
};

/** Relative time helper */
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

interface Props {
  result: JiraWatchResult;
  onDebug: (r: JiraWatchResult) => void;
  onResume: (r: JiraWatchResult) => void;
  onCancel: (r: JiraWatchResult) => void;
  onOpenSession: (r: JiraWatchResult) => void;
  onDelete: (id: number) => void;
  onClick: (r: JiraWatchResult) => void;
}

export function JiraTicketCard({ result, onDebug, onResume, onCancel, onOpenSession, onDelete, onClick }: Props) {
  const r = result;
  const isUnread = r.status === "done" && !r.readAt;
  const hasSession = !!r.sessionId;
  const canResume = r.status === "failed" && hasSession;
  const canDebug = r.status === "pending" || (r.status === "failed" && !hasSession);
  const canCancel = r.status === "queued" || r.status === "running";
  const status = r.status as JiraResultStatus;

  return (
    <div
      className={cn(
        "group rounded bg-card shadow-sm hover:shadow-md hover:bg-accent/50 hover:-translate-y-px cursor-pointer transition-all duration-150",
        "px-2.5 py-2 space-y-1",
        isUnread && "ring-1 ring-primary/30",
      )}
      onClick={() => onClick(r)}
    >
      {/* Line 1: issue key + summary + time */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-xs font-mono font-semibold text-foreground shrink-0">{r.issueKey}</span>
        {isUnread && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          {r.issueSummary || "No summary"}
        </span>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
          {timeAgo(r.createdAt)}
        </span>
      </div>

      {/* Line 2: status dot + label + action buttons */}
      <div className="flex items-center justify-between min-w-0">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full shrink-0", DOT_COLORS[status])} />
          {status}
        </span>

        <div
          className="flex items-center gap-0.5 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {canResume && (
            <button
              type="button"
              className="flex items-center gap-1 h-6 px-1.5 rounded text-[10px] font-medium text-primary hover:bg-primary/10 active:scale-95 transition-colors"
              onClick={() => onResume(r)}
              title="Resume debug session"
            >
              <RotateCcw className="size-3" />
              <span>Resume</span>
            </button>
          )}
          {canDebug && (
            <button
              type="button"
              className="flex items-center justify-center size-6 rounded text-muted-foreground hover:text-primary active:scale-95 transition-colors"
              onClick={() => onDebug(r)}
              title="Debug"
            >
              <Play className="size-3" />
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              className="flex items-center justify-center size-6 rounded text-muted-foreground hover:text-destructive active:scale-95 transition-colors"
              onClick={() => onCancel(r)}
              title="Stop debug"
            >
              <Square className="size-3" />
            </button>
          )}
          {r.status === "running" && (
            <Loader2 className="size-3 animate-spin text-primary" />
          )}
          {hasSession && (
            <button
              type="button"
              className="flex items-center gap-1 h-6 px-1.5 rounded text-[10px] font-medium text-primary hover:bg-primary/10 active:scale-95 transition-colors"
              onClick={() => onOpenSession(r)}
              title="Open session"
            >
              <ExternalLink className="size-3" />
              <span>Open</span>
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-center size-6 rounded text-muted-foreground hover:text-foreground active:scale-95 transition-colors"
              >
                <MoreHorizontal className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-destructive" onClick={() => onDelete(r.id)}>
                <Trash2 className="size-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
