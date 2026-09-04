/** Pure filter/sort/flatten/rollup for the process table. No React, no I/O, so the
 *  filter/sort/expand/rollup rules are unit-testable without mounting a component.
 *  Sort comparator lives in `process-table-sort.ts`, totals accumulator in
 *  `process-table-totals.ts` — both split out to stay under the file-size guideline. */
import type {
  MetricsHistoryPoint,
  ProcessGroup,
  ProcessInfo,
  SortDir,
  SortKey,
} from "../../../types/system-metrics";
import { sortByKey, sortFields } from "./process-table-sort";
import { accumulateTotals, EMPTY_TOTALS, type Totals } from "./process-table-totals";

export type { Totals } from "./process-table-totals";

export type TableRow =
  | { kind: "group"; group: ProcessGroup; expanded: boolean; spark: number[] }
  | { kind: "process"; proc: ProcessInfo; indent: boolean };

export interface BuildRowsInput {
  processes: ProcessInfo[];
  groups: ProcessGroup[];
  history: MetricsHistoryPoint[];
  mode: "grouped" | "flat";
  ppmOnly: boolean;
  query: string;
  sortKey: SortKey;
  sortDir: SortDir;
  expanded: Set<string>;
}

export interface BuildRowsResult {
  rows: TableRow[];
  totals: Totals;
  /** Group keys the search auto-expanded (only in grouped mode with a non-empty query). */
  autoExpanded: Set<string>;
}

const SPARK_POINTS = 60;

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

function processMatches(proc: ProcessInfo, query: string): boolean {
  return matches(proc.name, query) || matches(proc.command, query);
}

function sparkFor(history: MetricsHistoryPoint[], groupKey: string): number[] {
  return history.slice(-SPARK_POINTS).map((h) => h.groups[groupKey]?.cpu ?? 0);
}

/** Order fixed: filter (ppmOnly) -> filter (query) -> sort -> flatten (expand). */
export function buildRows(input: BuildRowsInput): BuildRowsResult {
  const { processes, groups, history, mode, ppmOnly, query, sortKey, sortDir, expanded } = input;
  const q = query.trim().toLowerCase();
  const byPid = new Map(processes.map((p) => [p.pid, p]));

  if (mode === "flat") {
    let flat = ppmOnly ? processes.filter((p) => p.ppm) : processes;
    if (q) flat = flat.filter((p) => processMatches(p, q));
    flat = sortByKey(flat, sortKey, sortDir, (p) => sortFields(p, p.name));

    const totals = flat.reduce((acc, p) => accumulateTotals(acc, p, 1), EMPTY_TOTALS);

    return {
      rows: flat.map((proc) => ({ kind: "process" as const, proc, indent: false })),
      totals,
      autoExpanded: new Set(),
    };
  }

  // Grouped mode.
  let filteredGroups = ppmOnly ? groups.filter((g) => g.ppm) : groups;

  const autoExpanded = new Set<string>();
  if (q) {
    filteredGroups = filteredGroups.filter((g) => {
      const labelMatch = matches(g.label, q);
      const memberMatch = g.pids.some((pid) => {
        const proc = byPid.get(pid);
        return proc ? processMatches(proc, q) : false;
      });
      const isMatch = labelMatch || memberMatch;
      if (isMatch && memberMatch) autoExpanded.add(g.key);
      return isMatch;
    });
  }

  filteredGroups = sortByKey(filteredGroups, sortKey, sortDir, (g) => sortFields(g, g.label));

  const rows: TableRow[] = [];
  for (const group of filteredGroups) {
    const isExpanded = q ? autoExpanded.has(group.key) || expanded.has(group.key) : expanded.has(group.key);
    rows.push({
      kind: "group",
      group,
      expanded: isExpanded,
      spark: sparkFor(history, group.key),
    });
    if (!isExpanded) continue;

    // Skip pids the current snapshot no longer has — a process can exit between the
    // server's tick and the client's render, or the group's own snapshot is already
    // one tick stale. Must not throw.
    let children = group.pids
      .map((pid) => byPid.get(pid))
      .filter((p): p is ProcessInfo => p !== undefined);
    if (q) children = children.filter((p) => processMatches(p, q));
    children = sortByKey(children, sortKey, sortDir, (p) => sortFields(p, p.name));
    for (const proc of children) {
      rows.push({ kind: "process", proc, indent: true });
    }
  }

  const totals = filteredGroups.reduce((acc, g) => accumulateTotals(acc, g, g.count), EMPTY_TOTALS);

  return { rows, totals, autoExpanded };
}

/** Three-state sort toggle: desc -> asc -> off, shared by every sortable column. */
export function toggleSort(current: SortKey, dir: SortDir, clicked: Exclude<SortKey, null>): [SortKey, SortDir] {
  if (current !== clicked) return [clicked, "desc"];
  if (dir === "desc") return [clicked, "asc"];
  return [null, "desc"];
}
