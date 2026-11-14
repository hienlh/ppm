/**
 * A prompt a session schedule sent into this chat. The person wrote it once, earlier, and PPM sent
 * it on its own at the time they chose — so it is drawn as one quiet line rather than as their
 * bubble: which schedule ran, when, and whether it was sent late or stood for several fires.
 * Tapping the line shows the prompt and when the schedule fires.
 *
 * Drawn from the message's own block, which is in the transcript text: it reads back the same
 * after a reload, for a Claude chat and a Codex chat alike, with no request.
 */
import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Clock } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { describeCron, formatInZone, zoneCity } from "@/lib/session-schedule-view";
import type { ScheduleRunReference } from "../../../shared/chat-schedule-run";

/** The muted note after the time: sent late, standing for later fires, or both. */
export function scheduleRunNote(run: Pick<ScheduleRunReference, "catchUp" | "coalesced">): string | null {
  const parts = [
    ...(run.catchUp ? ["sent late"] : []),
    ...(run.coalesced ? ["later fires folded in"] : []),
  ];
  return parts.length ? parts.join(" · ") : null;
}

export function ScheduleRunLine({ run, text, now }: {
  run: ScheduleRunReference;
  /** The prompt, without its block. */
  text: string;
  /** For tests: what "today" is when deciding whether to print the date. */
  now?: Date;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const note = scheduleRunNote(run);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col items-center" data-schedule-run={run.scheduleId}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        title={open ? "Hide the scheduled prompt" : "Show the scheduled prompt"}
        className="flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-full px-3 text-xs text-text-3 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-7"
      >
        <Clock className="size-3.5 shrink-0" />
        <span className="shrink-0">Schedule</span>
        <span className="min-w-0 truncate font-medium text-text-2">{run.name}</span>
        <span className="shrink-0">ran · {formatInZone(run.firedAt, run.timezone, now)}</span>
        {note && <span className="shrink-0 text-text-subtle">· {note}</span>}
        <Chevron className="size-3 shrink-0" />
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-1 w-full max-w-[85%] space-y-1.5 rounded-lg border border-border-soft bg-surface/40 px-3 py-2 text-xs"
        >
          <p className={cn("whitespace-pre-wrap break-words select-text text-sm text-text", !text && "text-text-subtle")}>
            {text || "(empty prompt)"}
          </p>
          <p className="text-[11px] text-text-subtle">
            {describeCron(run.cron)}
            {" · "}
            <span className="font-mono">{run.cron}</span>
            {" · "}
            {run.timezone ? zoneCity(run.timezone) : "the PPM host's time zone"}
            {run.scheduledFor !== run.firedAt && <> · due {formatInZone(run.scheduledFor, run.timezone, now)}</>}
          </p>
        </div>
      )}
    </div>
  );
}
