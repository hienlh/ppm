/**
 * The Apps page — Mission Center's Apps section.
 *
 * A row's figures are the sum over the app's whole process SUBTREE, which is why
 * the server sends only the roots and this computes the rest: a Chromium-shaped
 * app is dozens of processes under one root, and a row showing just the root
 * reads as permanently idle.
 */
import { useCallback, useMemo, useState } from "react";
import { Search } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { buildAppRows, filterAppRows, sortAppRows, type AppRow as AppRowData, type AppSortKey } from "./app-rows";
import { AppRow } from "./app-row";
import { KillConfirmDialog } from "../kill-confirm-dialog";
import { useProcessKill } from "../use-process-kill";
import { isGroupProtected } from "../build-kill-request";
import type { MetricsSnapshot, ProcessGroup, ProcessInfo } from "../../../../types/system-metrics";

const SORTS: { key: AppSortKey; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "Memory" },
  { key: "name", label: "Name" },
];

/**
 * An app ended as a group. `rootPid` is null on purpose: an app can have several
 * roots, so there is no single tree kill that covers it — `buildGroupKillRequests`
 * then ends each member individually, which reaches every helper.
 */
function groupForApp(app: AppRowData): ProcessGroup {
  return {
    key: `app:${app.id}`,
    label: app.name,
    rootPid: null,
    cpu: app.cpu,
    ramMB: app.ramMB,
    count: app.processCount,
    ppm: false,
    pids: app.memberPids,
  };
}

export function AppsPanel({ snapshot }: { snapshot: MetricsSnapshot }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<AppSortKey>("cpu");
  const { pendingKill, requestKillGroup, confirmKill, cancelKill } = useProcessKill(snapshot);

  const byPid = useMemo(
    () => new Map(snapshot.processes.map((p) => [p.pid, p])),
    [snapshot.processes],
  );
  const rows = useMemo(
    () => buildAppRows(snapshot.apps ?? [], snapshot.processes),
    [snapshot.apps, snapshot.processes],
  );
  const visible = useMemo(
    () => sortAppRows(filterAppRows(rows, query), sortKey, sortKey === "name" ? "asc" : "desc"),
    [rows, query, sortKey],
  );

  const protectedOf = useCallback(
    (app: AppRowData) => isGroupProtected(
      app.memberPids.map((pid) => byPid.get(pid)).filter((p): p is ProcessInfo => p !== undefined),
    ),
    [byPid],
  );

  if (snapshot.apps === undefined) {
    return (
      <div className="p-4 text-sm text-text-subtle" data-testid="sysmon-apps">
        This host does not list desktop applications.
      </div>
    );
  }

  return (
    // `@container` so the Swap column is dropped on the PANEL's width rather
    // than the viewport's — the System Monitor is a floating window on desktop.
    <div className="h-full flex flex-col min-h-0 @container" data-testid="sysmon-apps" data-app-count={visible.length}>
      <div className="shrink-0 flex flex-wrap items-center gap-2 p-2 border-b border-border">
        <div className="relative flex-1 min-w-[140px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search applications"
            aria-label="Search applications"
            data-testid="sysmon-app-search"
            className="w-full min-h-11 md:min-h-8 pl-7 pr-2 text-sm rounded-md border border-border bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSortKey(s.key)}
            aria-pressed={sortKey === s.key}
            data-testid={`sysmon-app-sort-${s.key}`}
            className={cn(
              "min-h-11 md:min-h-8 px-3 text-xs rounded-md border transition-colors",
              sortKey === s.key ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-surface-hover",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
        {visible.length === 0 && (
          <p className="p-4 text-sm text-text-subtle">
            {rows.length === 0 ? "No desktop applications are running." : "No applications match."}
          </p>
        )}
        {visible.map((app) => (
          <AppRow
            key={app.id}
            app={app}
            endProtected={protectedOf(app)}
            onEnd={(target) => requestKillGroup(groupForApp(target))}
          />
        ))}
      </div>

      <KillConfirmDialog target={pendingKill} onConfirm={confirmKill} onCancel={cancelKill} />
    </div>
  );
}
