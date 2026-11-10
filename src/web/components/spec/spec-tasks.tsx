/**
 * The approved tasks, by wave: what runs side by side and why a task was held back, each task's
 * state (red / green in Thorough) and its chat, with Run all / Stop and Start for one task.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  Check, CircleX, Clock, ExternalLink, FileText, FlaskConical, Loader2, Lock, Play, ShieldCheck, Square, X,
} from "@/lib/icons";
import { specsApi } from "@/lib/api-specs";
import { openSpecChat } from "@/lib/open-spec-chat";
import type { SpecTaskView, SpecView } from "../../../shared/spec-view";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SpecTasks({ spec, projectName, onUpdate, onShowDoc }: {
  spec: SpecView; projectName: string; onUpdate: (v: SpecView) => void; onShowDoc: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<{ spec?: SpecView; message?: string } | SpecView>) => {
    setBusy(key);
    try {
      const r = await fn();
      const view = "slug" in r ? r : r.spec;
      if (view) onUpdate(view);
      if (!("slug" in r) && r.message) toast.success(r.message);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const running = !!spec.run?.active && spec.runLive;
  const interrupted = !!spec.run?.active && !spec.runLive;
  const byId = new Map(spec.tasks.map((t) => [t.id, t]));
  const movedWhy = new Map(spec.waves.moved.map((m) => [m.id, m.reason]));
  const optional = spec.tasks.filter((t) => t.optional);
  const required = spec.tasks.filter((t) => !t.optional);
  const allDone = required.length > 0 && required.every((t) => t.done);

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-soft px-3 text-xs">
        <button type="button" onClick={onShowDoc} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-text-2 hover:bg-surface-hover">
          <FileText className="size-3.5" />{spec.phases.tasks.file}
        </button>
        <span className="flex-1" />
        {running && spec.run && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent-wash px-2.5 font-medium text-primary">
            <Loader2 className="size-3.5 animate-spin" />Wave {spec.run.wave + 1} of {spec.waves.waves.length}
          </span>
        )}
        {interrupted && <span className="text-warning">The run was interrupted by a restart</span>}
        {running || interrupted ? (
          <button type="button" disabled={busy !== null} onClick={() => void act("stop", () => specsApi.stop(projectName, spec.slug))} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 font-medium text-text hover:bg-panel-2">
            <Square className="size-3" />Stop
          </button>
        ) : !allDone && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("run", () => specsApi.runAll(projectName, spec.slug))}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-primary-foreground disabled:opacity-50"
            title="Each wave's tasks run side by side, each in a chat of its own (at most 3 at once)"
          >
            {busy === "run" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}Run all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {spec.suite && spec.suite.newFailures.length > 0 && (
          <div className="mb-2 rounded-md border border-error/30 bg-error/10 p-2.5 text-xs">
            <div className="mb-1 font-medium text-error">The whole suite has new failures</div>
            <ul className="list-disc space-y-0.5 pl-4 text-text-2">{spec.suite.newFailures.slice(0, 8).map((f) => <li key={f} className="font-mono text-[11px]">{f}</li>)}</ul>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-text-3">Tasks wait until a clean run.</span>
              <button type="button" disabled={busy !== null} onClick={() => void act("suite", () => specsApi.checkSuite(projectName, spec.slug))} className="h-7 rounded-md border border-border px-2 font-medium text-text hover:bg-panel-2">
                {busy === "suite" ? "Running…" : "Check again"}
              </button>
            </div>
          </div>
        )}
        {spec.waves.issues.filter((i) => i.severity === "error").map((i, k) => (
          <div key={k} className="mb-2 rounded-md border border-error/30 bg-error/10 p-2 text-xs text-error">{i.message}</div>
        ))}
        {spec.waves.waves.map((ids, w) => {
          const tasks = ids.map((id) => byId.get(id)).filter((t): t is SpecTaskView => !!t);
          const doneAll = tasks.every((t) => t.done);
          const live = tasks.filter((t) => t.status === "running" || t.status === "red").length;
          return (
            <section key={w} className="mb-2">
              <div className="flex items-center gap-2 px-1 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-3">
                <span>Wave {w + 1}</span>
                {doneAll ? <Pill tone="green"><Check className="size-3" />Done</Pill>
                  : live > 0 ? <Pill tone="accent"><Loader2 className="size-3 animate-spin" />{live} running</Pill>
                  : tasks.length > 1 ? <Pill tone="mute">{tasks.length} side by side</Pill> : null}
              </div>
              {tasks.map((t) => (
                <TaskRow key={t.id} spec={spec} task={t} why={movedWhy.get(t.id)} busy={busy} projectName={projectName}
                  onStart={() => void act(`start-${t.id}`, () => specsApi.runTask(projectName, spec.slug, t.id))}
                  onReset={() => void act(`reset-${t.id}`, () => specsApi.resetTask(projectName, spec.slug, t.id))} />
              ))}
            </section>
          );
        })}
        {optional.length > 0 && (
          <section className="mb-2">
            <div className="px-1 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-3">Optional · not in Run all</div>
            {optional.map((t) => (
              <TaskRow key={t.id} spec={spec} task={t} busy={busy} projectName={projectName}
                onStart={() => void act(`start-${t.id}`, () => specsApi.runTask(projectName, spec.slug, t.id))}
                onReset={() => void act(`reset-${t.id}`, () => specsApi.resetTask(projectName, spec.slug, t.id))} />
            ))}
          </section>
        )}
        {spec.tasks.length === 0 && <p className="p-2 text-sm text-text-subtle">tasks.md lists no tasks.</p>}
      </div>

      {spec.checks === "thorough" && (
        <div className="flex shrink-0 items-start gap-2 border-t border-border-soft px-3 py-2 text-[11.5px] text-text-3">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          <span>
            {spec.baselineRunning ? "Recording the suite's failures before the work…"
              : spec.baseline ? `Baseline: ${spec.baseline.failing.length} test${spec.baseline.failing.length === 1 ? "" : "s"} already failed before this spec, so green means no new failures.`
              : "The whole suite is compared with how it stood before the first task."}
            {spec.suiteRunning && " Running the whole suite…"}
          </span>
        </div>
      )}
    </>
  );
}

function TaskRow({ spec, task: t, why, busy, projectName, onStart, onReset }: {
  spec: SpecView; task: SpecTaskView; why?: string; busy: string | null; projectName: string; onStart: () => void; onReset: () => void;
}) {
  const active = t.status === "running" || t.status === "red";
  const last = t.run?.lastRun ?? (t.status === "red" ? t.run?.red : t.done ? t.run?.green : undefined);
  const refs = [
    t.requirements.length ? `Req ${t.requirements.join(" · ")}` : null,
    t.deps.length ? `Deps: ${t.deps.join(", ")}` : null,
    t.files.length ? `Files: ${t.files.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className={`grid grid-cols-[20px_1fr_auto] items-start gap-2.5 rounded-lg px-2 py-2 ${active ? "bg-panel-2" : ""}`}>
      <StateDot task={t} thorough={spec.checks === "thorough"} />
      <div className="min-w-0">
        <div className={`text-[13px] ${t.done ? "text-text-2" : "font-medium text-text"}`}>{t.id}. {t.title}</div>
        {refs && <div className="mt-0.5 truncate text-[11px] text-text-3" title={refs}>{refs}</div>}
        {why && <div className="mt-0.5 text-[11px] text-info">Later wave: {why}</div>}
        {spec.checks === "thorough" && t.status === "red" && t.tests.length > 0 && (
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-text-2"><Lock className="size-3 text-text-3" /><span className="truncate font-mono">{t.tests.join(", ")}</span><span className="text-text-3">· locked since red</span></div>
        )}
        {t.status === "failed" && t.run?.error && <div className="mt-1 text-[11.5px] text-error">{t.run.error}</div>}
        {last && !t.done && (
          <pre className="mt-1.5 max-h-28 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-snug text-text-2">
            {last.outcome} · {last.failed ?? 0} fail · {last.passed ?? 0} pass{last.failing.length ? `\n${last.failing.slice(0, 5).map((f) => `✗ ${f}`).join("\n")}` : ""}
          </pre>
        )}
        {!t.done && t.next === "blocked" && t.blockedReason && !active && <div className="mt-0.5 text-[11px] text-text-3">{t.blockedReason}</div>}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        {t.done ? <Pill tone="green">{t.run?.green ? `Green · ${t.run.green.passed ?? 0} pass` : "Done"}</Pill>
          : t.status === "red" ? <Pill tone="red">Red · writing code</Pill>
          : t.status === "running" ? <Pill tone="accent">{spec.checks === "thorough" && !t.noTest ? "Writing tests" : "Running"}</Pill>
          : t.status === "failed" ? <Pill tone="red">Failed</Pill>
          : t.optional ? <Pill tone="mute">Optional</Pill> : null}
        {t.run?.sessionId && (active || t.status === "failed" || t.done) && (
          <button type="button" onClick={() => void openSpecChat(projectName, t.run!.sessionId!, `${spec.title} · ${t.id}`)} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-2 hover:bg-surface-hover" title="Open this task's chat">
            Chat<ExternalLink className="size-3" />
          </button>
        )}
        {t.next === "start" && t.status !== "failed" && !spec.run?.active && (
          <button type="button" disabled={busy !== null} onClick={onStart} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:bg-surface-hover" title="Ask the spec's chat to run this task">
            <Play className="size-3.5" />Start
          </button>
        )}
        {(active || t.status === "failed") && !spec.run?.active && (
          <button type="button" disabled={busy !== null} onClick={onReset} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-3 hover:bg-surface-hover" title="Put the task back to not started (unlocks its tests)">
            <X className="size-3.5" />Reset
          </button>
        )}
      </div>
    </div>
  );
}

function StateDot({ task: t, thorough }: { task: SpecTaskView; thorough: boolean }) {
  const base = "mt-0.5 flex size-5 items-center justify-center rounded-full";
  if (t.done) return <span className={`${base} bg-success/15 text-success`}><Check className="size-3" /></span>;
  if (t.status === "red") return <span className={`${base} bg-error/15 text-error`} title="Tests fail, as they must before the code"><FlaskConical className="size-3" /></span>;
  if (t.status === "running") return <span className={`${base} bg-accent-wash text-primary`}><Loader2 className="size-3.5 animate-spin" /></span>;
  if (t.status === "failed") return <span className={`${base} bg-error/15 text-error`}><CircleX className="size-3" /></span>;
  if (t.next === "blocked") return <span className={`${base} bg-panel-2 text-text-3`}><Clock className="size-3" /></span>;
  return <span className={`${base} border border-border`} title={thorough ? "Not started" : undefined} />;
}

function Pill({ tone, children }: { tone: "green" | "red" | "accent" | "mute"; children: React.ReactNode }) {
  const cls = tone === "green" ? "bg-success/15 text-success" : tone === "red" ? "bg-error/15 text-error" : tone === "accent" ? "bg-accent-wash text-primary" : "bg-panel-2 text-text-3";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal ${cls}`}>{children}</span>;
}
