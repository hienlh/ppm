import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/api-client";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { buildRows, toggleSort } from "./process-table-model";
import { buildKillRequest } from "./build-kill-request";
import { buildProcessGrid, gridCssVars } from "./process-columns-grid";
import { ProcessTableToolbar, ProcessTableHeader, ProcessTableFooter } from "./process-table-toolbar";
import { ProcessGroupRow } from "./process-group-row";
import { ProcessRow } from "./process-row";
import { KillConfirmDialog } from "./kill-confirm-dialog";
import type {
  KillProcessRequest,
  KillProcessResult,
  MetricsHistoryPoint,
  MetricsSnapshot,
  ProcessInfo,
  SortDir,
  SortKey,
} from "../../../types/system-metrics";

/** Older cached bundles/snapshots (mid-rollout) predate `processColumns` — default
 *  every optional column off rather than let a missing field throw. */
const NO_OPTIONAL_COLUMNS = { disk: false, gpu: false, net: false };

export interface ProcessTableProps {
  snapshot: MetricsSnapshot;
  history: MetricsHistoryPoint[];
}

/** `api.post` (src/web/lib/api-client.ts) has no way to add a bespoke header, and the
 *  kill route requires `X-PPM-Request: 1` — CSRF hardening, since a cross-origin HTML
 *  form cannot set a custom header, so a preflight becomes mandatory. A raw fetch here
 *  mirrors `handleResponse`'s single-Error-on-any-failure contract exactly, so the
 *  caller still has exactly one catch path. */
async function killProcess(request: KillProcessRequest): Promise<KillProcessResult> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PPM-Request": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/system/resources/kill", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  let json: { ok: boolean; data?: KillProcessResult; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
  }
  if (json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.data as KillProcessResult;
}

export function ProcessTable({ snapshot, history }: ProcessTableProps) {
  const isMobile = useIsMobile();
  const parentRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<"grouped" | "flat">("grouped");
  const [ppmOnly, setPpmOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pendingKill, setPendingKill] = useState<ProcessInfo | null>(null);

  const { rows, totals } = useMemo(
    () =>
      buildRows({
        processes: snapshot.processes,
        groups: snapshot.groups,
        history,
        mode,
        ppmOnly,
        query,
        sortKey,
        sortDir,
        expanded,
      }),
    [snapshot.processes, snapshot.groups, history, mode, ppmOnly, query, sortKey, sortDir, expanded],
  );

  const columns = snapshot.processColumns ?? NO_OPTIONAL_COLUMNS;
  const grid = useMemo(() => buildProcessGrid(columns, sortKey), [columns, sortKey]);
  const gpuUtilPercent = snapshot.system.gpus[0]?.utilPercent;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (isMobile ? 44 : 28),
    overscan: 12,
  });

  const handleSort = useCallback(
    (field: Exclude<SortKey, null>) => {
      const [nextKey, nextDir] = toggleSort(sortKey, sortDir, field);
      setSortKey(nextKey);
      setSortDir(nextDir);
    },
    [sortKey, sortDir],
  );

  const handleToggleGroup = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleConfirmKill = useCallback(async (proc: ProcessInfo, tree: boolean) => {
    setPendingKill(null);
    try {
      await killProcess(buildKillRequest(proc, tree));
      toast.success(`Ended ${proc.name} (${proc.pid})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to end ${proc.name}`);
    }
  }, []);

  // `@container`: the trend/age track is toggled on the table's own width, not the
  // viewport — a floating window is routinely narrower than the screen it sits on.
  // `gridCssVars` sets `--sysmon-grid-n`/`--sysmon-grid-w` once here; CSS custom
  // properties inherit to every row/header/footer below without re-passing style.
  return (
    <div
      className="h-full flex flex-col min-h-0 @container"
      style={gridCssVars(grid)}
      data-testid="sysmon-processes"
      data-row-count={rows.length}
    >
      <ProcessTableToolbar
        mode={mode}
        onModeChange={setMode}
        ppmOnly={ppmOnly}
        onPpmOnlyChange={setPpmOnly}
        onQueryChange={setQuery}
      />
      <ProcessTableHeader sortKey={sortKey} sortDir={sortDir} grid={grid} onSort={handleSort} />
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={row.kind === "group" ? row.group.key : `p:${row.proc.pid}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "group" ? (
                  <ProcessGroupRow
                    group={row.group}
                    expanded={row.expanded}
                    spark={row.spark}
                    grid={grid}
                    onToggle={handleToggleGroup}
                  />
                ) : (
                  <ProcessRow proc={row.proc} indent={row.indent} grid={grid} onKillClick={setPendingKill} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ProcessTableFooter totals={totals} grid={grid} gpuUtilPercent={gpuUtilPercent} />
      <KillConfirmDialog
        process={pendingKill}
        onConfirm={handleConfirmKill}
        onCancel={() => setPendingKill(null)}
      />
    </div>
  );
}
