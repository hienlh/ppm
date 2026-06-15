/** Settings section: manage scheduled Claude agents (cron). */
import { useState } from "react";
import { Plus, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSchedules } from "@/hooks/use-schedules";
import { ScheduleRow } from "./schedule-row";
import { ScheduleForm } from "./schedule-form";
import type { Schedule } from "../../../../types/scheduler";

export function SchedulesSettingsSection() {
  const { schedules, loading, refetch } = useSchedules();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (s: Schedule) => { setEditing(s); setFormOpen(true); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Periodically wake Claude to work on a project unattended.
        </p>
        <Button size="sm" onClick={openCreate} className="min-h-11 md:min-h-8 text-xs gap-1 cursor-pointer shrink-0">
          <Plus className="size-3.5" /> Add
        </Button>
      </div>

      {loading && schedules.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">Loading…</p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CalendarClock className="size-8 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            No schedules yet. Add one to run Claude periodically.
          </p>
          <Button size="sm" onClick={openCreate} className="min-h-11 text-xs gap-1 cursor-pointer">
            <Plus className="size-3.5" /> Add schedule
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onEdit={() => openEdit(s)} onChanged={refetch} />
          ))}
        </div>
      )}

      <ScheduleForm open={formOpen} schedule={editing} onClose={() => setFormOpen(false)} onSaved={refetch} />
    </div>
  );
}
