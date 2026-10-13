/** One schedule row — tap to expand runs, long-press/right-click for actions. */
import { useState } from "react";
import {
  Play, Pencil, Trash2, Power, ChevronDown, ChevronRight, RotateCw, ScrollText, Download, FileCode, MessageSquare,
} from "@/lib/icons";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/adaptive-context-menu";
import { downloadBlob } from "@/components/remote-desktop/remote-desktop-recording";
import { serializeScheduleTemplate, type ScheduleTemplate } from "../../../../shared/schedule-template";
import { ScheduleRuns } from "./schedule-runs";
import { ScheduleStatusChip } from "./schedule-status-chip";
import type { ScheduleView } from "../../../../types/scheduler";

export function ScheduleRow({
  schedule,
  onEdit,
  onLogs,
  onChanged,
}: {
  schedule: ScheduleView;
  onEdit: () => void;
  onLogs: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runsKey, setRunsKey] = useState(0); // bump to force runs refetch after run-now
  const isScript = schedule.kind === "script";
  const alwaysOn = schedule.mode === "always-on";
  const KindIcon = isScript ? FileCode : MessageSquare;

  const runNow = async () => {
    try {
      const res = await api.post<{ runId: number | null; wasRunning: boolean }>(`/api/schedules/${schedule.id}/run-now`);
      // A script tick keeps a run only if it has something to show, so it has no number yet.
      if (res.runId !== null) toast.success(`Run #${res.runId} started${res.wasRunning ? " (previous run still active)" : ""}`);
      else toast.success(alwaysOn ? "Restarting" : "Tick started");
      setExpanded(true);
      setRunsKey((k) => k + 1);
      onChanged();
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

  const exportTemplate = async () => {
    try {
      const res = await api.get<{ template: ScheduleTemplate; fileName: string; warnings: string[] }>(`/api/schedules/${schedule.id}/export`);
      downloadBlob(new Blob([serializeScheduleTemplate(res.template)], { type: "application/json" }), res.fileName);
      const note = "Non-secret input values were included as defaults. Secrets were left out.";
      if (res.warnings.length) toast.warning("Template exported — check it before sharing", { description: [note, ...res.warnings].join("\n") });
      else toast.success("Template exported", { description: note });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
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

  const when = alwaysOn
    ? "Always on"
    : <><span className="font-mono">{schedule.cron_expr}</span>{" · "}{schedule.next_fire_at && schedule.enabled ? `next ${new Date(schedule.next_fire_at).toLocaleString()}` : "—"}</>;

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
            <KindIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{schedule.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{when}</p>
            </div>
            <ScheduleStatusChip schedule={schedule} />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={runNow}>
            {alwaysOn ? <><RotateCw className="size-3.5" /> Restart</> : <><Play className="size-3.5" /> Run now</>}
          </ContextMenuItem>
          <ContextMenuItem onClick={toggleEnabled}>
            <Power className="size-3.5" /> {schedule.enabled ? "Disable" : "Enable"}
          </ContextMenuItem>
          <ContextMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </ContextMenuItem>
          {isScript && (
            <ContextMenuItem onClick={onLogs}>
              <ScrollText className="size-3.5" /> Logs
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={exportTemplate}>
            <Download className="size-3.5" /> Export template
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={remove}>
            <Trash2 className="size-3.5" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          <p className="text-[11px] text-muted-foreground break-all line-clamp-3">
            {isScript ? schedule.description || "Script schedule" : schedule.prompt}
          </p>
          {schedule.status.lastError && <p className="text-[11px] text-error break-all line-clamp-3">{schedule.status.lastError}</p>}
          <ScheduleRuns key={runsKey} scheduleId={schedule.id} />
        </div>
      )}
    </div>
  );
}
