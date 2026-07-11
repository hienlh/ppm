/** One schedule row — tap to expand runs, long-press/right-click for actions. */
import { useState } from "react";
import { Play, Pencil, Trash2, Power, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/adaptive-context-menu";
import { ScheduleRuns } from "./schedule-runs";
import type { Schedule } from "../../../../types/scheduler";

export function ScheduleRow({
  schedule,
  onEdit,
  onChanged,
}: {
  schedule: Schedule;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runsKey, setRunsKey] = useState(0); // bump to force runs refetch after run-now

  const runNow = async () => {
    try {
      const res = await api.post<{ runId: number; wasRunning: boolean }>(`/api/schedules/${schedule.id}/run-now`);
      toast.success(`Run #${res.runId} started${res.wasRunning ? " (previous run still active)" : ""}`);
      setExpanded(true);
      setRunsKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    }
  };

  const toggleEnabled = async () => {
    try {
      await api.patch(`/api/schedules/${schedule.id}`, { enabled: !schedule.enabled });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const remove = async () => {
    try {
      await api.del(`/api/schedules/${schedule.id}`);
      toast.success("Schedule deleted");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="rounded-lg border border-border">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-2 px-2.5 py-2.5 min-h-11 text-left cursor-pointer hover:bg-accent/30"
          >
            {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{schedule.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                <span className="font-mono">{schedule.cron_expr}</span>
                {" · "}
                {schedule.next_fire_at && schedule.enabled
                  ? `next ${new Date(schedule.next_fire_at).toLocaleString()}`
                  : "—"}
              </p>
            </div>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0",
                schedule.enabled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
              )}
            >
              {schedule.enabled ? "Enabled" : "Disabled"}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={runNow}>
            <Play className="size-3.5" /> Run now
          </ContextMenuItem>
          <ContextMenuItem onClick={toggleEnabled}>
            <Power className="size-3.5" /> {schedule.enabled ? "Disable" : "Enable"}
          </ContextMenuItem>
          <ContextMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={remove}>
            <Trash2 className="size-3.5" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          <p className="text-[11px] text-muted-foreground break-all line-clamp-3">{schedule.prompt}</p>
          <ScheduleRuns key={runsKey} scheduleId={schedule.id} />
        </div>
      )}
    </div>
  );
}
