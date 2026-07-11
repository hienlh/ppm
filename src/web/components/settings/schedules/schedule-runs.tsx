/** Run history list for one schedule — status pills + expandable output. */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useScheduleRuns } from "@/hooks/use-schedules";
import type { ScheduleRun } from "../../../../types/scheduler";

const STATUS_STYLES: Record<string, string> = {
  done: "bg-success/10 text-success",
  error: "bg-error/10 text-error",
  running: "bg-warning/10 text-warning",
  skipped: "bg-muted text-muted-foreground",
};

export function ScheduleRuns({ scheduleId }: { scheduleId: number }) {
  const { runs, loading } = useScheduleRuns(scheduleId);

  if (loading && runs.length === 0) {
    return <p className="text-[11px] text-muted-foreground py-1">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return <p className="text-[11px] text-muted-foreground py-1">No runs yet.</p>;
  }
  return (
    <div className="space-y-1">
      {runs.map((run) => <RunRow key={run.id} run={run} />)}
    </div>
  );
}

/** Parse both SQLite "YYYY-MM-DD HH:MM:SS" (UTC) and ISO-8601 timestamps. */
function parseUtc(ts: string): Date {
  return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

function RunRow({ run }: { run: ScheduleRun }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !!(run.output_truncated || run.error);
  const duration = run.ended_at
    ? `${Math.round((parseUtc(run.ended_at).getTime() - parseUtc(run.started_at).getTime()) / 1000)}s`
    : "…";

  return (
    <div className="rounded border border-border text-[11px]">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-2 min-h-11 text-left",
          hasDetails && "cursor-pointer hover:bg-accent/30",
        )}
      >
        <span className={cn("rounded px-1.5 py-0.5 font-medium shrink-0", STATUS_STYLES[run.status])}>
          {run.status}
        </span>
        <span className="text-muted-foreground truncate flex-1">
          {parseUtc(run.started_at).toLocaleString()} · {duration}
          {run.cost_usd != null && ` · $${run.cost_usd.toFixed(4)}`}
          {run.context_window_pct != null && ` · ctx ${run.context_window_pct}%`}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {run.error && <p className="text-error break-all">{run.error}</p>}
          {run.output_truncated && (
            <pre className="overflow-auto max-h-96 whitespace-pre-wrap break-all text-muted-foreground font-mono text-[10px]">
              {run.output_truncated}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
