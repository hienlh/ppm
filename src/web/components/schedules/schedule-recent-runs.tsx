/**
 * The newest runs of one schedule in the Schedules window: outcome, when, how long and what it
 * cost, with the run's chat one click away and its error or output a click below. Rows are sized
 * by the chip standard (`control-size.ts`), not the 44px of the older Settings list.
 */
import { useState } from "react";
import { ExternalLink } from "@/lib/icons";
import { useScheduleRuns } from "@/hooks/use-schedules";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { parseStamp } from "../../../shared/schedule-attention";
import { relativeAgo } from "@/lib/schedules/schedules-view";
import type { ScheduleRun } from "../../../types/scheduler";
import { ICON_BUTTON, RunStatusLine } from "./schedules-ui";

const SHOWN = 5;

function duration(run: ScheduleRun): string {
  if (!run.ended_at) return "running";
  const s = Math.max(0, Math.round((parseStamp(run.ended_at) - parseStamp(run.started_at)) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

const TONE = { done: "ok", error: "bad", running: "running", skipped: "none" } as const;
const WORD = { done: "Done", error: "Failed", running: "Running", skipped: "Skipped" } as const;

export function ScheduleRecentRuns({ scheduleId, now, onOpenChat }: {
  scheduleId: number;
  now: number;
  onOpenChat?: (sessionId: string) => void;
}) {
  const { runs, loading } = useScheduleRuns(scheduleId);
  const [open, setOpen] = useState<number | null>(null);
  if (loading && runs.length === 0) return <p className="text-[11px] text-text-3">Loading runs…</p>;
  if (runs.length === 0) return <p className="text-[11px] text-text-3">Not run yet.</p>;
  return (
    <ul className="flex flex-col">
      {runs.slice(0, SHOWN).map((run) => {
        const chat = run.rotated_to_session_id ?? run.session_id;
        const details = run.error ?? run.output_truncated;
        return (
          <li key={run.id} data-run={run.id} className="border-b border-border-soft last:border-b-0">
            <div className={cn("flex items-center gap-2", TEXT_CONTROL_HEIGHT)}>
              <button type="button" data-tap-area="" disabled={!details} onClick={() => setOpen(open === run.id ? null : run.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default">
                <RunStatusLine tone={TONE[run.status]} text={WORD[run.status]} />
                <span className="truncate text-[11px] text-text-3">
                  {relativeAgo(parseStamp(run.started_at), now)} · {duration(run)}{run.cost_usd != null ? ` · $${run.cost_usd.toFixed(2)}` : ""}
                </span>
              </button>
              {chat && onOpenChat && (
                <button type="button" aria-label="Open this run's chat" title="Open this run's chat" className={ICON_BUTTON} onClick={() => onOpenChat(chat)}>
                  <ExternalLink />
                </button>
              )}
            </div>
            {open === run.id && details && (
              <pre className={cn("mb-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 font-mono text-[10.5px]", run.error ? "text-error-ink" : "text-text-2")}>
                {details}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
