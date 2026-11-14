/**
 * The fields that depend on what a schedule runs: a prompt on a cron, a script on a cron or always
 * on, or a prompt sent into an existing chat on a cron read in its own time zone.
 */
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { draftsToDecls, type ScheduleFormState } from "@/lib/schedule-form-model";
import { formatInZone } from "@/lib/session-schedule-view";
import { cronProblem, nextFires } from "../../../../shared/schedule-cron";
import { timezoneProblem } from "../../../../shared/session-schedule-input";
import type { ScheduleKind } from "../../../../types/scheduler";
import { ScheduleInputsEditor } from "./schedule-inputs-editor";
import { ScheduleInputValues } from "./schedule-input-values";

const ScheduleScriptEditor = lazy(() => import("./schedule-script-editor").then((m) => ({ default: m.ScheduleScriptEditor })));

type Set = <K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]) => void;

export function ScheduleKindFields({ form, set, secretsSet, afterCron }: {
  form: ScheduleFormState;
  set: Set;
  secretsSet: readonly string[];
  /** Fields that belong right under the cron (a session schedule's time zone). */
  afterCron?: ReactNode;
}) {
  const decls = useMemo(() => draftsToDecls(form.inputs), [form.inputs]);
  return (
    <>
      {form.kind === "script" && (
        <Field label="Mode">
          <Segmented
            value={form.mode}
            options={[["tick", "Tick"], ["always-on", "Always on"]]}
            onChange={(v) => set("mode", v)}
          />
          <p className="text-[11px] text-muted-foreground">
            {form.mode === "tick" ? "Runs once on each cron fire, to the end." : "Kept running; started again if it stops."}
          </p>
        </Field>
      )}
      {form.mode === "tick" && (
        <CronField kind={form.kind} value={form.cron} timezone={form.kind === "session" ? form.timezone : ""} onChange={(v) => set("cron", v)} />
      )}
      {afterCron}
      {form.kind !== "script" ? (
        <Field label="Prompt (do not embed secrets)">
          <textarea
            value={form.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            placeholder="Check open PRs and summarize. If nothing to do, finish immediately."
            rows={4}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 resize-y"
          />
        </Field>
      ) : (
        <>
          <Field label="Script">
            <Suspense fallback={<p className="text-[11px] text-muted-foreground py-2">Loading editor…</p>}>
              <ScheduleScriptEditor value={form.script} onChange={(v) => set("script", v)} />
            </Suspense>
          </Field>
          <Field label="Inputs">
            <ScheduleInputsEditor inputs={form.inputs} onChange={(v) => set("inputs", v)} />
          </Field>
          {decls.length > 0 && (
            <Field label="Values">
              <ScheduleInputValues
                decls={decls.filter((d) => d.key)}
                values={form.values}
                secrets={form.secrets}
                secretsSet={secretsSet}
                onValue={(k, v) => set("values", { ...form.values, [k]: v })}
                onSecret={(k, v) => set("secrets", { ...form.secrets, [k]: v })}
              />
            </Field>
          )}
        </>
      )}
      {/* A session schedule runs on its chat's own settings: no turn cap, no timeout of its own. */}
      {form.kind !== "session" && <div className="grid grid-cols-2 gap-2">
        {form.kind === "prompt" && (
          <Field label="Max turns (optional)">
            <Input type="number" min={1} value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} placeholder="∞" className="h-11 md:h-9 text-xs" />
          </Field>
        )}
        {form.mode === "tick" && (
          <Field label="Timeout (ms)">
            <Input type="number" min={10_000} value={form.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} className="h-11 md:h-9 text-xs" />
          </Field>
        )}
      </div>}
    </>
  );
}

function CronField({ kind, value, timezone, onChange }: { kind: ScheduleKind; value: string; timezone: string; onChange: (v: string) => void }) {
  // A zone that does not parse is named by its own field; the hint then reads the cron locally.
  const zone = timezone.trim() && !timezoneProblem(timezone.trim()) ? timezone.trim() : null;
  const hint = useMemo(() => {
    if (!value.trim()) return "—";
    const problem = cronProblem(value, kind, zone);
    if (problem) return problem;
    if (zone) return `Next: ${nextFires(value, 3, undefined, zone).map((d) => formatInZone(d.toISOString(), zone)).join(" · ")}`;
    return `Next: ${nextFires(value, 3).map((d) => d.toLocaleString()).join(" · ")}`;
  }, [value, kind, zone]);
  const label = kind === "script" ? "Cron (local timezone; seconds first is allowed)"
    : kind === "session" ? "Cron expression (in the time zone below)"
    : "Cron expression (local timezone)";
  return (
    <Field label={label}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={kind === "script" ? "*/30 * * * * *" : "0 7 * * *"} className="h-11 md:h-9 text-xs font-mono" />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </Field>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-flow-col auto-cols-fr gap-1 rounded-md border border-border p-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "min-h-11 md:min-h-8 rounded text-xs font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
            value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-accent/40",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
