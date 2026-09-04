import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { buildRows, toggleSort } from "./process-table-model";
import { buildProcessGrid, gridCssVars } from "./process-columns-grid";
import { ProcessTableToolbar, ProcessTableHeader, ProcessTableFooter } from "./process-table-toolbar";
import { ProcessGroupRow } from "./process-group-row";
import { ProcessRow } from "./process-row";
import { KillConfirmDialog } from "./kill-confirm-dialog";
import { useProcessKill } from "./use-process-kill";
import { useColumnWidths } from "./use-column-widths";
import type { MetricsSnapshot, SortDir, SortKey } from "../../../types/system-metrics";

/** Older cached bundles/snapshots (mid-rollout) predate `processColumns` — default
 *  every optional column off rather than let a missing field throw. */
const NO_OPTIONAL_COLUMNS = { disk: false, gpu: false, net: false };

export interface ProcessTableProps {
  snapshot: MetricsSnapshot;
}

export function ProcessTable({ snapshot }: ProcessTableProps) {
  const isMobile = useIsMobile();
  const parentRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<"grouped" | "flat">("grouped");
  const [ppmOnly, setPpmOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { pendingKill, groupProtected, requestKillProcess, requestKillGroup, confirmKill, cancelKill } =
    useProcessKill(snapshot);
  const { widths, begin: onResizeStart, reset: onResizeReset } = useColumnWidths();

  const { rows, totals } = useMemo(
    () =>
      buildRows({
        processes: snapshot.processes,
        groups: snapshot.groups,
        mode,
        ppmOnly,
        query,
        sortKey,
        sortDir,
        expanded,
      }),
    [snapshot.processes, snapshot.groups, mode, ppmOnly, query, sortKey, sortDir, expanded],
  );

  const columns = snapshot.processColumns ?? NO_OPTIONAL_COLUMNS;
  const grid = useMemo(() => buildProcessGrid(columns, sortKey, widths), [columns, sortKey, widths]);
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
      <ProcessTableHeader
        sortKey={sortKey}
        sortDir={sortDir}
        grid={grid}
        onSort={handleSort}
        resize={{ onResizeStart, onResizeReset }}
      />
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
                    grid={grid}
                    killProtected={groupProtected.get(row.group.key) ?? true}
                    onToggle={handleToggleGroup}
                    onKillClick={requestKillGroup}
                  />
                ) : (
                  <ProcessRow proc={row.proc} indent={row.indent} grid={grid} onKillClick={requestKillProcess} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ProcessTableFooter totals={totals} grid={grid} gpuUtilPercent={gpuUtilPercent} />
      <KillConfirmDialog
        target={pendingKill}
        onConfirm={confirmKill}
        onCancel={cancelKill}
      />
    </div>
  );
}
