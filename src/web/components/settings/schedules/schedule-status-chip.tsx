/** A schedule's state in a word or two: on or off, and for a script, what its process is doing. */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ScheduleView } from "../../../../types/scheduler";

const TONES = {
  ok: "bg-success/10 text-success",
  wait: "bg-warning/10 text-warning",
  bad: "bg-error/10 text-error",
  off: "bg-muted text-muted-foreground",
} as const;

export function scheduleStatusLabel(s: ScheduleView, now: number): { text: string; tone: keyof typeof TONES } {
  const { state, restartAt } = s.status;
  switch (state) {
    case "running": return { text: "Running", tone: "ok" };
    case "restarting": {
      if (!restartAt) return { text: "Restarting", tone: "wait" };
      return { text: `Restarting in ${Math.max(0, Math.ceil((Date.parse(restartAt) - now) / 1000))} s`, tone: "wait" };
    }
    case "starting": return { text: "Starting", tone: "wait" };
    case "stopping": return { text: "Stopping", tone: "wait" };
    case "failed": return { text: "Failed", tone: "bad" };
    case "blocked": return { text: "Blocked", tone: "bad" };
    case "stopped": return { text: "Stopped", tone: "off" };
    default: return s.enabled ? { text: "Enabled", tone: "ok" } : { text: "Disabled", tone: "off" };
  }
}

export function ScheduleStatusChip({ schedule, className }: { schedule: ScheduleView; className?: string }) {
  const counting = schedule.status.state === "restarting";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting, schedule.status.restartAt]);
  const { text, tone } = scheduleStatusLabel(schedule, now);
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 whitespace-nowrap", TONES[tone], className)}>
      {text}
    </span>
  );
}
