/**
 * The chat footer's context meter: "Ctx 42%" in the footer cluster, and a popover that says what
 * fills the window (Claude's `/context`, asked of the session's live CLI) with Compact now.
 *
 * The figure on the chip is the one the last turn reported (`contextWindowPct`) until the popover
 * reads a fresher one. A session with no live Claude process has no breakdown: the popover says
 * so and still offers Compact now, which starts one.
 */
import { useEffect, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextUsageView } from "../../../shared/context-usage";
import { UsageRing, UsageTrack } from "./usage-meters";

export function contextPctClass(pct: number): string {
  if (pct >= 90) return "text-error";
  if (pct >= 75) return "text-warning";
  return "text-text-2";
}

/** The chip's face: a small ring, "Ctx" and the figure. */
export function ContextMeterFace({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center gap-1" data-context-meter="">
      <UsageRing pct={pct} className="!size-3 @max-[420px]/chat:hidden max-md:hidden" />
      <span className="text-text-3">Ctx</span>
      <span className={cn("font-medium tabular-nums", contextPctClass(pct))}>{pct}%</span>
    </span>
  );
}

type Load = { state: "loading" } | { state: "none" } | { state: "ready"; usage: ContextUsageView } | { state: "error"; message: string };

/** Asks the server what fills the session's context while the popover is open. */
function useContextUsage(projectName: string, sessionId: string | null | undefined, open: boolean) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    if (!open || !sessionId) return;
    const ctl = new AbortController();
    setLoad({ state: "loading" });
    api.get<{ usage: ContextUsageView | null }>(`${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/context-usage`, { signal: ctl.signal })
      .then((r) => setLoad(r.usage ? { state: "ready", usage: r.usage } : { state: "none" }))
      .catch((e) => { if (!ctl.signal.aborted) setLoad({ state: "error", message: (e as Error).message }); });
    return () => ctl.abort();
  }, [projectName, sessionId, open]);
  return load;
}

export function ContextMeterPanel({
  projectName, sessionId, open, lastPct, onCompact, onFresh,
}: {
  projectName: string;
  sessionId: string | null | undefined;
  open: boolean;
  lastPct: number | null;
  /** Sends `/compact`; absent while a turn runs. */
  onCompact?: () => void;
  /** A fresher figure than the last turn's, for the chip. */
  onFresh?: (pct: number) => void;
}) {
  const load = useContextUsage(projectName, sessionId, open);
  useEffect(() => { if (load.state === "ready") onFresh?.(load.usage.percentage); }, [load, onFresh]);
  const pct = load.state === "ready" ? load.usage.percentage : lastPct;
  return (
    <div className="flex flex-col gap-3 p-3 text-[12px] max-md:text-[13px]" data-context-panel={load.state}>
      <div className="flex items-baseline justify-between gap-3">
        <b className="text-[13px] font-semibold max-md:text-sm">Context</b>
        {pct != null && <span className={cn("tabular-nums font-medium", contextPctClass(pct))}>{pct}% used</span>}
      </div>
      {pct != null && <UsageTrack pct={pct} />}
      {load.state === "loading" && <p className="text-text-3">Reading what fills the context…</p>}
      {load.state === "none" && (
        <p className="text-text-3">The breakdown appears while this chat&apos;s Claude process is running. {lastPct != null ? "The figure is from the last turn." : ""}</p>
      )}
      {load.state === "error" && <p className="text-error">Could not read the context: {load.message}</p>}
      {load.state === "ready" && (
        <>
          <div className="text-text-3 tabular-nums">
            {formatTokens(load.usage.totalTokens)} of {formatTokens(load.usage.maxTokens)} tokens · {load.usage.model}
          </div>
          <ul className="flex flex-col gap-1" aria-label="What fills the context">
            {load.usage.rows.map((r) => (
              <li key={r.id} data-context-row={r.id} className="flex items-center gap-2">
                <span className={cn("min-w-0 flex-1 truncate", r.kind === "used" ? "text-text" : "text-text-3")}>{r.name}</span>
                <span className="tabular-nums text-text-2">{formatTokens(r.tokens)}</span>
                <span className="w-10 text-right tabular-nums text-text-3">{load.usage.maxTokens > 0 ? `${Math.round((r.tokens / load.usage.maxTokens) * 100)}%` : ""}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!onCompact}
          onClick={onCompact}
          title={onCompact ? "Summarise the conversation so far to free up context" : "Wait for the current turn to finish"}
          className="h-7 rounded-md border border-border px-2.5 text-[12px] text-text-2 transition-colors can-hover:hover:bg-surface-hover can-hover:hover:text-text disabled:opacity-50 max-md:h-[26px]"
        >
          Compact now
        </button>
      </div>
    </div>
  );
}
