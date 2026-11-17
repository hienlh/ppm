/**
 * The task page's "Remind…": pick when the project's manager chat should be reminded about this
 * task — in an hour, this evening, tomorrow morning, or a time of your own on a clock you choose
 * (this device's by default) — and an optional note. A popover on a desktop, a bottom sheet below
 * `md` (design-guidelines rule 1), like Snooze beside it. The reminder is a one-shot schedule the
 * task owns (`POST /api/tasks/:id/reminders`), so closing the task removes it.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { toast } from "sonner";
import { CalendarClock } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useSchedulesOverviewStore } from "@/stores/schedules-overview-store";
import { localMomentText, REMINDER_NOTE_MAX, reminderChoices } from "../../../shared/task-reminder";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { ScheduleOverview } from "../../../types/scheduler";

const deviceZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
};

function zoneOptions(current: string): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { /* old browser */ }
  return all.includes(current) ? all : [current, ...all];
}

const ROW = "flex min-h-7 max-md:min-h-[26px] w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] text-text hover:bg-surface-hover disabled:opacity-45 max-md:text-[15px]";
const FIELD = cn("min-w-0 rounded-md border border-border bg-surface px-2 text-[13px] text-text outline-none focus:border-ring", TEXT_CONTROL_HEIGHT);

function RemindOptions({ task, onDone }: { task: Pick<TaskDto, "id">; onDone: () => void }) {
  const [zone, setZone] = useState(deviceZone);
  const [at, setAt] = useState(() => localMomentText(new Date(Date.now() + 2 * 3_600_000), deviceZone()).replace(/\d\d$/, "00"));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => reminderChoices(new Date(), zone), [zone]);
  const zones = useMemo(() => zoneOptions(zone), [zone]);

  const save = async (moment: string) => {
    setBusy(true);
    try {
      const created = await api.post<ScheduleOverview>(`/api/tasks/${task.id}/reminders`, { at: moment, timezone: zone, ...(note.trim() && { note: note.trim() }) });
      useSchedulesOverviewStore.getState().put(created);
      toast.success(`Reminder set for ${moment.slice(11)}${zone === deviceZone() ? "" : ` (${zone.split("/").pop()})`}`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set the reminder");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="menu" aria-label="Remind at" data-task-remind-options="" className="flex flex-col gap-0.5">
      {choices.map((c) => (
        <button key={c.id} type="button" role="menuitem" data-remind-choice={c.id} disabled={busy} className={ROW} onClick={() => void save(c.at)}>
          <CalendarClock aria-hidden className="size-4 shrink-0 text-text-3" />
          <span className="shrink-0">{c.label}</span>
          <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-text-3">{c.at.slice(11)}{c.id === "morning" ? " tomorrow" : ""}</span>
        </button>
      ))}
      <form data-remind-form="" className="mt-1 flex flex-col gap-1.5 border-t border-border-soft px-2 pt-2"
        onSubmit={(e) => { e.preventDefault(); void save(at); }}>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Pick a time</span>
        <div className="flex gap-1.5">
          <input type="datetime-local" aria-label="Remind at" value={at} min={localMomentText(new Date(), zone)} onChange={(e) => setAt(e.target.value)} className={cn(FIELD, "flex-1")} />
        </div>
        <select aria-label="Time zone" value={zone} onChange={(e) => setZone(e.target.value)} className={FIELD}>
          {zones.map((z) => <option key={z} value={z}>{z === deviceZone() ? `${z} (this device)` : z}</option>)}
        </select>
        <input type="text" aria-label="Note" placeholder="Note for the manager (optional)" maxLength={REMINDER_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} />
        <button type="submit" disabled={busy || !at} data-remind-save=""
          className={cn("inline-flex items-center justify-center self-end rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-45", TEXT_CONTROL_HEIGHT)}>
          Set reminder
        </button>
      </form>
      <p className="px-2 pt-1.5 text-[11px] leading-snug text-text-3">The project's manager chat gets it once it is idle. Closing the task removes it.</p>
    </div>
  );
}

function Heading() {
  return <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-text-3 max-md:px-0 max-md:pb-2 max-md:text-[15px] max-md:normal-case max-md:tracking-normal max-md:text-text">Remind the manager at…</p>;
}

export function TaskRemindButton({ task, className, children }: { task: Pick<TaskDto, "id" | "baseGroup">; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();
  if (task.baseGroup === "closed") return null;
  const trigger = (
    <button ref={button} type="button" data-task-remind-button="" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-2.5 text-[11.5px] text-text-2 hover:text-text max-md:px-[5px] [&_svg]:size-3.5",
        TEXT_CONTROL_HEIGHT, className,
      )}>
      <CalendarClock aria-hidden />{children ?? "Remind…"}
    </button>
  );
  if (isMobile) {
    return (
      <>
        {trigger}
        <BottomSheet open={open} onClose={() => setOpen(false)} className="flex max-h-[88%] flex-col">
          {open && (
            <div role="dialog" aria-label="Remind at" data-task-remind-sheet="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
              <Heading />
              <RemindOptions task={task} onDone={() => setOpen(false)} />
            </div>
          )}
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>{trigger}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} aria-label="Remind at" data-task-remind-popover=""
          onPointerDownOutside={(e) => { if (button.current?.contains(e.target as Node)) e.preventDefault(); }}
          className="z-50 w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-panel-2 p-1.5 font-sans shadow-lg">
          <Heading />
          <RemindOptions task={task} onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
