/**
 * The results under the editor, as DBGate shows them: a tab strip — Messages first, then
 * "Result 1…N" in the order the results came — over the tab picked, and while the run goes on,
 * which statement is running and for how long, with its Stop.
 *
 * A result tab is drawn when it is first shown and kept afterwards, hidden: rows edited in one
 * result survive a look at another, and a run of fifty results does not build fifty grids.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, ScrollText, Square, TableSimple } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { MessagesPanel } from "./messages-panel";
import { countOf, MESSAGES_TAB, type QueryRun, type QueryResultTab } from "./query-run-state";

export function ResultTabs({ run, shown, onPick, onShowLine, onStop, stopping, renderResult }: {
  run: QueryRun;
  /** The key of the tab shown (`shownResultTab`). */
  shown: string;
  onPick: (key: string) => void;
  onShowLine?: (line: number) => void;
  onStop: () => void;
  stopping: boolean;
  renderResult: (tab: QueryResultTab) => ReactNode;
}) {
  // The result tabs drawn so far in this run.
  const drawn = useRef<{ runId: string; keys: Set<string> }>({ runId: "", keys: new Set() });
  if (drawn.current.runId !== run.runId) drawn.current = { runId: run.runId, keys: new Set() };
  if (shown !== MESSAGES_TAB) drawn.current.keys.add(shown);

  const errors = run.messages.filter((m) => m.level === "error").length;
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div role="tablist" aria-label="Results" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel pl-1 max-md:h-auto">
        <ResultTabButton selected={shown === MESSAGES_TAB} onClick={() => onPick(MESSAGES_TAB)} icon={<ScrollText className="size-3.5" />}>
          Messages
          {errors > 0 && <span className="rounded-full bg-destructive/15 px-1.5 font-mono text-[10.5px] text-destructive" aria-label={countOf(errors, "error")}>{errors}</span>}
        </ResultTabButton>
        {run.tabs.map((t) => {
          const rows = run.results.find((r) => r.index === t.statement)?.resultSets[t.set]?.rows.length ?? 0;
          return (
            <ResultTabButton key={t.key} selected={shown === t.key} onClick={() => onPick(t.key)} icon={<TableSimple className="size-3.5" />}>
              {t.title}
              <span className="font-mono text-[10.5px] text-text-subtle" aria-label={countOf(rows, "row")}>{rows.toLocaleString("en-US")}</span>
            </ResultTabButton>
          );
        })}
      </div>
      <div role="tabpanel" className={cn("min-h-0 flex-1 flex-col overflow-hidden", shown === MESSAGES_TAB ? "flex" : "hidden")}>
        <MessagesPanel messages={run.messages} onShowLine={onShowLine} />
      </div>
      {run.tabs.filter((t) => drawn.current.keys.has(t.key)).map((t) => (
        <div key={t.key} role="tabpanel" aria-label={t.title} className={cn("min-h-0 flex-1 flex-col overflow-hidden", shown === t.key ? "flex" : "hidden")}>
          {renderResult(t)}
        </div>
      ))}
      {!run.done && <RunningBox run={run} onStop={onStop} stopping={stopping} />}
    </div>
  );
}

function ResultTabButton({ selected, onClick, icon, children }: { selected: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button" role="tab" aria-selected={selected} onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs whitespace-nowrap max-md:min-h-11 max-md:px-3.5 max-md:text-[13px]",
        selected ? "border-primary text-text-primary" : "border-transparent text-text-2 can-hover:hover:text-text-primary",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * "Running statement 2/3 1.4 s" and Stop, over the results and out of their way — for as long as
 * the run goes on, so it does not blink out between two statements of a quick script.
 */
function RunningBox({ run, onStop, stopping }: { run: QueryRun; onStop: () => void; stopping: boolean }) {
  const since = run.running?.since ?? run.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const total = run.statements.length;
  const seconds = Math.max(0, (now - since) / 1000).toFixed(1);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-[10px] border border-border bg-panel px-3.5 py-2 text-xs shadow-lg max-md:text-sm">
        <Loader2 aria-hidden className="size-4 animate-spin text-text-subtle" />
        <span role="status">{run.running ? `Running statement ${run.running.index + 1}${total > 1 ? `/${total}` : ""}` : "Running…"}</span>
        <span aria-hidden className="font-mono text-text-subtle tabular-nums">{seconds} s</span>
        <button
          type="button" onClick={onStop} disabled={stopping}
          className="flex h-7 items-center gap-1.5 rounded-md bg-destructive px-2.5 font-medium text-destructive-foreground disabled:opacity-60 max-md:h-11 max-md:px-3.5"
        >
          <Square aria-hidden className="size-3.5" />{stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    </div>
  );
}
