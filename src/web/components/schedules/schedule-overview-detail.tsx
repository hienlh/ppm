/**
 * One schedule in full: a warning when it runs in Bypass, its problem and Dismiss, the actions,
 * when it runs (cron, in words, zone, next three), its prompt and its recent runs. The right-hand
 * pane of a wide window, the expanded row of a narrow one, and the sheet a phone opens on a tap.
 */
import { useMemo, type ReactNode } from "react";
import { AlertTriangle, ClipboardCheck, FileText, MessageSquare, Pencil, Play, Trash2 } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { describeCron } from "../../../shared/cron-in-words";
import { parseStamp, scheduleAttention } from "../../../shared/schedule-attention";
import { clockLabel, isBypass, KIND_LABELS, projectLabel, zoneCity } from "@/lib/schedules/schedules-view";
import type { ScheduleOverview } from "../../../types/scheduler";
import { ScheduleRecentRuns } from "./schedule-recent-runs";
import { ICON_BUTTON, KindIcon, PRIMARY_BUTTON, ProjectTag, TEXT_BUTTON } from "./schedules-ui";
import type { ScheduleActions } from "./use-schedule-actions";

export interface ScheduleDetailProps {
  schedule: ScheduleOverview;
  now: number;
  actions: ScheduleActions;
  onEdit: () => void;
  onOpenPrompt: () => void;
  /** Leave out the title block: the row above already shows it. */
  bare?: boolean;
  className?: string;
}

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="rounded-lg border border-border bg-panel p-2.5">
    <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-3">{title}</h4>
    {children}
  </section>
);

export function ScheduleOverviewDetail({ schedule: s, now, actions, onEdit, onOpenPrompt, bare, className }: ScheduleDetailProps) {
  const problem = scheduleAttention(s, now);
  const bypass = isBypass(s);
  const zone = s.timezone;
  // Computed by the host, which reads the cron on its own clock: a browser elsewhere shows the same instants.
  const upcoming = useMemo(() => s.next_fires.map((at) => clockLabel(parseStamp(at), zone, now)), [s.next_fires, zone, now]);
  const chat = actions.chatOf(s);

  return (
    <div data-schedule-detail={s.id} className={cn("flex flex-col gap-3", className)}>
      {!bare && (
        <div className="flex items-start gap-2">
          <KindIcon kind={s.kind} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug break-words">{s.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-3">
              <ProjectTag name={projectLabel(s)} />
              <span>{KIND_LABELS[s.kind]}</span>
            </div>
          </div>
          <Switch aria-label={s.enabled ? "Turn off" : "Turn on"} checked={!!s.enabled} onCheckedChange={(v) => void actions.setEnabled(s, v)} />
        </div>
      )}

      {bypass && (
        <div data-bypass-warning="" className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning-ink">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p><b>Bypass permissions.</b> Every tool runs without asking, in {projectLabel(s)}, with nobody watching when it fires.
            {s.kind === "session" && " This is its chat's own mode."}</p>
        </div>
      )}

      {problem && (
        <div data-attention={problem.kind} className="flex items-start gap-2 rounded-lg border border-error/40 bg-error/10 px-2.5 py-2 text-xs text-error-ink">
          <p className="min-w-0 flex-1"><b>{problem.text}.</b>{problem.detail && <span className="break-words"> {problem.detail}</span>}</p>
          <button type="button" className={TEXT_BUTTON} onClick={() => void actions.dismiss(s)}>Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={PRIMARY_BUTTON} onClick={() => void actions.runNow(s)}><Play />Run now</button>
        <button type="button" className={TEXT_BUTTON} onClick={onOpenPrompt}><FileText />{s.kind === "script" ? "Open script" : "Open prompt"}</button>
        <button type="button" className={TEXT_BUTTON} onClick={onEdit}><Pencil />Edit</button>
        {s.task && <button type="button" className={TEXT_BUTTON} onClick={() => actions.openTask(s)}><ClipboardCheck />{s.task.ref}</button>}
        {chat && <button type="button" className={TEXT_BUTTON} onClick={() => actions.openChat(s)}><MessageSquare />Open chat</button>}
        <button type="button" aria-label="Delete" title="Delete" className={cn(ICON_BUTTON, "hover:text-error")} onClick={() => void actions.remove(s)}><Trash2 /></button>
      </div>

      {s.mode === "tick" && (
        <Card title="When">
          <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <dt className="text-text-3">Cron</dt><dd className="font-mono">{s.cron_expr}</dd>
            <dt className="text-text-3">In words</dt><dd>{describeCron(s.cron_expr)}{s.kind === "session" && !s.recurring ? ", once" : ""}</dd>
            <dt className="text-text-3">Zone</dt><dd>{zone ? zoneCity(zone) : "The PPM host's"}</dd>
            <dt className="text-text-3">Next</dt><dd>{upcoming.length ? upcoming.join(" · ") : "—"}</dd>
            {s.target_title !== undefined && s.kind === "session" && (<><dt className="text-text-3">Sends to</dt><dd className="truncate">{s.target_title ?? "its chat"}</dd></>)}
          </dl>
        </Card>
      )}

      {s.kind !== "script" && (
        <Card title="Prompt">
          <button type="button" data-tap-area="" onClick={onOpenPrompt} title="Open the whole prompt"
            className="block w-full max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-panel-2 p-2 text-left font-mono text-[11.5px] leading-relaxed text-text-2 hover:text-foreground">
            {s.prompt}
          </button>
        </Card>
      )}

      <Card title="Recent runs">
        <ScheduleRecentRuns scheduleId={s.id} now={now} onOpenChat={(id) => actions.openChatId(s, id)} />
      </Card>
    </div>
  );
}
