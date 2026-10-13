/** A script schedule's live log — what its process prints, as it prints it — and what it is doing. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Play, RotateCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { ScheduleStatusView, ScheduleView } from "../../../../types/scheduler";
import { ScheduleSheet } from "./schedule-sheet";
import { ScheduleStatusChip } from "./schedule-status-chip";

const POLL_MS = 2000;
const KEEP_LINES = 1000;

interface LogLine { seq: number; at: string; text: string }

export function ScheduleLogsSheet({ schedule, onClose, onChanged }: {
  schedule: ScheduleView | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<ScheduleStatusView | null>(null);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  /** Keep the newest line in view, unless the reader has scrolled up to read. */
  const follow = useRef(true);
  const id = schedule?.id;

  useEffect(() => {
    if (id === undefined) return;
    let stopped = false;
    let busy = false;
    last.current = 0;
    follow.current = true;
    setLines([]);
    setStatus(null);
    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const res = await api.get<{ status: ScheduleStatusView; lines: LogLine[]; last: number }>(`/api/schedules/${id}/logs?after=${last.current}`);
        if (stopped) return;
        setStatus(res.status);
        // The server started again, and its line numbers with it.
        const restarted = res.last < last.current;
        const fresh = restarted ? (await api.get<{ lines: LogLine[] }>(`/api/schedules/${id}/logs`)).lines : res.lines;
        if (stopped) return;
        if (restarted) setLines([]);
        if (fresh.length) {
          last.current = fresh[fresh.length - 1]!.seq;
          setLines((prev) => [...prev, ...fresh].slice(-KEEP_LINES));
        } else if (restarted) last.current = 0;
      } catch { /* the next poll tries again */ } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void poll(); }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [id]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!schedule) return null;
  const alwaysOn = schedule.mode === "always-on";
  const shown = { ...schedule, status: status ?? schedule.status };

  const runNow = async () => {
    try {
      await api.post(`/api/schedules/${schedule.id}/run-now`);
      toast.success(alwaysOn ? "Restarting" : "Tick started");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    }
  };

  return (
    <ScheduleSheet open onClose={onClose} title={`Logs: ${schedule.name}`} wide>
      <div className="space-y-2 px-1">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
          <ScheduleStatusChip schedule={shown} />
          {shown.status.pid !== null && <span>pid {shown.status.pid}</span>}
          {shown.status.since && <span className="truncate">since {new Date(shown.status.since).toLocaleString()}</span>}
          {shown.status.restarts > 0 && <span>{shown.status.restarts} restarts</span>}
        </div>
        {shown.status.lastError && <p className="text-[11px] text-error break-all whitespace-pre-wrap line-clamp-6">{shown.status.lastError}</p>}
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-[50vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="text-muted-foreground">Nothing printed yet. Lines from ctx.log and console appear here as they are printed.</p>
          ) : (
            lines.map((l) => (
              <p key={l.seq} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">{new Date(l.at).toLocaleTimeString()} </span>{l.text}
              </p>
            ))
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" onClick={onClose} className="min-h-11 cursor-pointer">Close</Button>
          <Button type="button" onClick={runNow} disabled={alwaysOn && !schedule.enabled} className="min-h-11 gap-1 cursor-pointer">
            {alwaysOn ? <><RotateCw className="size-4" /> Restart</> : <><Play className="size-4" /> Run now</>}
          </Button>
        </div>
      </div>
    </ScheduleSheet>
  );
}
