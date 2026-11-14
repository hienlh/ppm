/**
 * The schedules aimed at this chat, as one chip in the footer's context row: a clock and how many.
 * Absent while the chat has none. A dot on it means one needs a glance — PPM paused it, or it came
 * due and is waiting for the chat to be idle.
 *
 * It opens a popover (a bottom sheet on a phone) listing each schedule: when it next runs in its
 * own time zone, whether it runs once or keeps running, what it is doing, and Pause/Resume and
 * Delete. Deleting asks once more in place, since the popover is already the thing in front.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Clock, Pause, Play, Trash2 } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useSessionSchedules } from "@/hooks/use-session-schedules";
import { describeCron, needsAttention, nextRunText, sessionScheduleStatus, type SessionScheduleTone } from "@/lib/session-schedule-view";
import { FooterButton, FooterPopover, FooterPopoverHeader } from "./footer-popover";
import { FOOTER_CHIP, HIDE_NARROW } from "./footer-chip";
import type { ScheduleView } from "../../../types/scheduler";

const TONE_CLASS: Record<SessionScheduleTone, string> = {
  ok: "bg-success/10 text-success",
  wait: "bg-warning/10 text-warning",
  bad: "bg-error/10 text-error",
  off: "bg-muted text-muted-foreground",
};

/** The error the server gave, as one sentence. */
function failure(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function SessionSchedulesChip({ sessionId }: { sessionId: string | null | undefined }) {
  const { schedules, refetch } = useSessionSchedules(sessionId);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  if (schedules.length === 0) return null;
  const attention = schedules.some(needsAttention);
  const count = schedules.length;
  const label = `${count} ${count === 1 ? "schedule" : "schedules"}`;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={() => { if (!open) void refetch(); setOpen(!open); }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={attention ? `${label} — one needs a look` : `${label} for this chat`}
        data-testid="session-schedules-chip"
        data-attention={attention ? "true" : undefined}
        className={cn(FOOTER_CHIP, attention && "border-warning/40 text-warning")}
      >
        <Clock />
        <b className={cn("font-medium tabular-nums", attention ? "text-warning" : "text-text")}>{count}</b>
        <span className={HIDE_NARROW}>{count === 1 ? "schedule" : "schedules"}</span>
        {attention && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
      </button>

      <FooterPopover open={open} onClose={() => setOpen(false)} label="Schedules for this chat" anchorRef={chipRef}>
        <FooterPopoverHeader>
          <Clock className="size-3.5 shrink-0 text-text-3" />
          <b className="truncate text-[13px] font-semibold max-md:text-sm">{label}</b>
        </FooterPopoverHeader>
        <div className="max-h-72 min-h-0 overflow-y-auto overscroll-contain max-md:max-h-none max-md:flex-1">
          {schedules.map((s) => <SessionScheduleItem key={s.id} schedule={s} onChanged={refetch} />)}
          <p className="px-3 py-2 text-[11px] leading-relaxed text-text-subtle max-md:px-4 max-md:text-xs">
            A schedule sends its prompt into this chat on its own, once the chat is idle. Settings → Schedules lists them all.
          </p>
        </div>
      </FooterPopover>
    </>
  );
}

/** One schedule in the popover, with its own actions. */
export function SessionScheduleItem({ schedule: s, onChanged }: { schedule: ScheduleView; onChanged: () => unknown }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = sessionScheduleStatus(s);
  const on = !!s.enabled && !s.paused_reason;

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (e) {
      toast.error(failure(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => run(() => api.patch(`/api/schedules/${s.id}`, { enabled: !on }), on ? "Could not pause it" : "Could not resume it");
  const remove = () => run(async () => {
    await api.del(`/api/schedules/${s.id}`);
    setConfirming(false);
  }, "Could not delete it");

  return (
    <div className="border-b border-border-soft px-3 py-2 max-md:px-4 max-md:py-3" data-session-schedule={s.id}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text max-md:text-sm">{s.name}</span>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", TONE_CLASS[status.tone])}>{status.text}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-text-3 max-md:text-xs">
        {describeCron(s.cron_expr)} · {s.recurring ? "Repeats" : "Runs once"}
      </p>
      <p className="text-[11px] text-text-3 max-md:text-xs">{nextRunText(s)}</p>
      {status.detail && (
        <p className={cn("mt-0.5 break-words text-[11px] max-md:text-xs", status.tone === "bad" ? "text-error" : "text-text-subtle")}>{status.detail}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1 max-md:gap-2">
        {confirming ? (
          <>
            <span className="mr-auto text-[11px] text-text-2 max-md:text-xs">Delete this schedule?</span>
            <FooterButton onClick={() => setConfirming(false)} disabled={busy}>Cancel</FooterButton>
            <FooterButton variant="danger-fill" onClick={remove} disabled={busy} data-testid="session-schedule-confirm-delete">
              <Trash2 />
              Delete
            </FooterButton>
          </>
        ) : (
          <>
            <FooterButton onClick={toggle} disabled={busy} data-testid="session-schedule-toggle">
              {on ? <Pause /> : <Play />}
              {on ? "Pause" : "Resume"}
            </FooterButton>
            <FooterButton variant="danger" onClick={() => setConfirming(true)} disabled={busy} data-testid="session-schedule-delete">
              <Trash2 />
              Delete
            </FooterButton>
          </>
        )}
      </div>
    </div>
  );
}
