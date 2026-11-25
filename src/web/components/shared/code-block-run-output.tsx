import { useCallback, useEffect, useRef, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { normalizeTerminalCommand } from "@/lib/run-in-terminal";
import { Loader2, Square, X } from "@/lib/icons";

/** What `POST /api/project/:name/shell/run` answers. */
export interface CodeBlockRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  durationMs: number;
}

export type CodeBlockRunState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "done"; result: CodeBlockRunResult }
  | { phase: "error"; message: string };

/**
 * The Run button's state for one code block. Stop aborts the request, and the server kills the
 * run when its request closes; unmounting the block (the message scrolled out of a virtualized
 * list, the chat closed) stops it the same way.
 */
export function useCodeBlockRun(projectName: string | null | undefined) {
  const [state, setState] = useState<CodeBlockRunState>({ phase: "idle" });
  const ctlRef = useRef<AbortController | null>(null);

  useEffect(() => () => ctlRef.current?.abort(), []);

  const run = useCallback(async (text: string) => {
    if (!projectName) return;
    const command = normalizeTerminalCommand(text);
    if (!command) return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setState({ phase: "running", startedAt: Date.now() });
    try {
      const result = await api.post<CodeBlockRunResult>(`${projectUrl(projectName)}/shell/run`, { command }, { signal: ctl.signal });
      if (ctlRef.current === ctl) setState({ phase: "done", result });
    } catch (e) {
      if (ctlRef.current !== ctl) return;
      setState(ctl.signal.aborted
        ? { phase: "done", result: { output: "", exitCode: null, timedOut: false, stopped: true, durationMs: 0 } }
        : { phase: "error", message: (e as Error).message });
    } finally {
      if (ctlRef.current === ctl) ctlRef.current = null;
    }
  }, [projectName]);

  const stop = useCallback(() => ctlRef.current?.abort(), []);
  const close = useCallback(() => {
    ctlRef.current?.abort();
    ctlRef.current = null;
    setState({ phase: "idle" });
  }, []);

  return { state, run, stop, close };
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return ms < 10_000 && ms > 0 ? `${(ms / 1000).toFixed(1)}s` : `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** One line saying how the run ended. */
export function runStatusLine(r: CodeBlockRunResult): string {
  if (r.stopped) return "Stopped";
  if (r.timedOut) return `Stopped at the time limit · ${formatElapsed(r.durationMs)}`;
  if (r.exitCode === null) return "Could not start";
  return `Exit ${r.exitCode} · ${formatElapsed(r.durationMs)}`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{formatElapsed(now - since)}</>;
}

const iconBtn = "flex items-center justify-center size-6 max-md:size-[22px] rounded text-text-secondary hover:text-text-primary hover:bg-surface-elevated transition-colors";

/** What a Run printed, under its code block. */
export function CodeBlockRunOutput({ state, onStop, onClose }: { state: CodeBlockRunState; onStop: () => void; onClose: () => void }) {
  if (state.phase === "idle") return null;
  const failed = state.phase === "error" || (state.phase === "done" && state.result.exitCode !== 0);
  const output = state.phase === "done" ? state.result.output.replace(/\s+$/, "") : "";
  return (
    <div data-code-block-run={state.phase} className="mt-1 rounded-md border border-border/60 bg-surface text-xs">
      <div className="flex items-center gap-2 px-2 py-1 text-text-secondary">
        {state.phase === "running" && <Loader2 className="size-3.5 animate-spin" />}
        <span className={`min-w-0 flex-1 truncate ${failed ? "text-error" : ""}`}>
          {state.phase === "running" && <>Running · <Elapsed since={state.startedAt} /></>}
          {state.phase === "done" && runStatusLine(state.result)}
          {state.phase === "error" && `Could not run: ${state.message}`}
        </span>
        {state.phase === "running"
          ? <button type="button" className={iconBtn} title="Stop" aria-label="Stop" onClick={onStop}><Square className="size-3" /></button>
          : <button type="button" className={iconBtn} title="Close" aria-label="Close output" onClick={onClose}><X className="size-3.5" /></button>}
      </div>
      {state.phase === "done" && (
        <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-border/60 px-2 py-1.5 font-mono text-[12px] leading-snug text-text-primary">
          {output || <span className="text-text-secondary">(no output)</span>}
        </pre>
      )}
    </div>
  );
}
