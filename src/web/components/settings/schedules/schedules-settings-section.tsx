/** Settings section: manage scheduled Claude agents (cron) and script schedules. */
import { useState } from "react";
import { Plus, CalendarClock, Upload } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useSchedules } from "@/hooks/use-schedules";
import { ScheduleRow } from "./schedule-row";
import { ScheduleForm } from "./schedule-form";
import { ScheduleImportSheet } from "./schedule-import-sheet";
import { ScheduleLogsSheet } from "./schedule-logs-sheet";
import type { ScheduleView } from "../../../../types/scheduler";

export function SchedulesSettingsSection() {
  const { schedules, loading, refetch } = useSchedules();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [logsId, setLogsId] = useState<number | null>(null);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (s: ScheduleView) => { setEditing(s); setFormOpen(true); };
  // The list is polled; the sheet follows the latest copy of its schedule.
  const logsFor = schedules.find((s) => s.id === logsId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Periodically wake Claude to work on a project unattended, or run a script on a cron or always on.
        </p>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} className="min-h-11 md:min-h-8 text-xs gap-1 cursor-pointer">
            <Upload className="size-3.5" /> Import
          </Button>
          <Button size="sm" onClick={openCreate} className="min-h-11 md:min-h-8 text-xs gap-1 cursor-pointer">
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      </div>

      {loading && schedules.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">Loading…</p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CalendarClock className="size-8 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            No schedules yet. Add one to run Claude or a script periodically, or import a template.
          </p>
          <Button size="sm" onClick={openCreate} className="min-h-11 text-xs gap-1 cursor-pointer">
            <Plus className="size-3.5" /> Add schedule
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onEdit={() => openEdit(s)} onLogs={() => setLogsId(s.id)} onChanged={refetch} />
          ))}
        </div>
      )}

      <ScheduleForm open={formOpen} schedule={editing} onClose={() => setFormOpen(false)} onSaved={refetch} />
      <ScheduleImportSheet open={importOpen} onClose={() => setImportOpen(false)} onImported={refetch} />
      <ScheduleLogsSheet schedule={logsFor} onClose={() => setLogsId(null)} onChanged={refetch} />
    </div>
  );
}
