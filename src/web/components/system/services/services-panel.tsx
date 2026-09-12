/**
 * The Services page — Mission Center's Services tab.
 *
 * The two scopes are separate sections rather than one flat list: a user unit and
 * a system unit of the same name are different units with very different
 * consequences, and a flat list gives no way to tell them apart.
 */
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { runServiceAction, useServices } from "./use-services";
import { SERVICE_FILTERS, serviceCounts, shapeServices, type ServiceFilter } from "./service-rows";
import { ServiceRow } from "./service-row";
import { ServicesHeader } from "./services-header";
import { serviceGridCssVars } from "./service-columns";
import { sortServiceRows, type ServiceSortKey } from "./service-sort";
import { toggleSort } from "../process-table-model";
import { resourcesFor, rollUpByUnit } from "./service-resources";
import { ServiceDetailsSheet } from "./service-details-sheet";
import {
  ServiceActionConfirm, needsConfirm, type PendingServiceAction,
} from "./service-action-confirm";
import type { MetricsSnapshot, SortDir } from "../../../../types/system-metrics";
import type { ServiceAction, ServiceInfo, ServiceScope } from "../../../../types/system-services";

const SCOPES: readonly ServiceScope[] = ["system", "user"];
const SCOPE_LABELS: Record<ServiceScope, string> = { system: "System", user: "User" };
const FILTER_LABELS: Record<ServiceFilter, string> = {
  all: "All", running: "Running", failed: "Failed", enabled: "Enabled",
};

/** `metrics` is the live 2 s stream the Processes tab is already receiving. The
 *  unit list itself comes from `systemctl` on a separate 3 s poll, so the two
 *  arrive independently and a row simply shows dashes until the first full tick
 *  carrying process rows lands. */
export function ServicesPanel({ active, metrics }: { active: boolean; metrics?: MetricsSnapshot | null }) {
  const { snapshot, error, loading, refresh } = useServices(active);
  const [scope, setScope] = useState<ServiceScope>("system");
  const [filter, setFilter] = useState<ServiceFilter>("all");
  const [query, setQuery] = useState("");
  // `null` = the page's own order (failed first, then running, then by name),
  // which the third click of a header returns to.
  const [sortKey, setSortKey] = useState<ServiceSortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [details, setDetails] = useState<ServiceInfo | null>(null);
  const [pending, setPending] = useState<PendingServiceAction | null>(null);

  const services = snapshot?.services ?? [];
  const shaped = useMemo(() => shapeServices(services, scope, filter, query), [services, scope, filter, query]);
  const counts = useMemo(() => serviceCounts(services, scope), [services, scope]);
  // The light tier carries no process rows at all, so there is nothing to sum
  // and every row must say so rather than reading as a machine at rest.
  const byUnit = useMemo(
    () => (metrics?.processes.length ? rollUpByUnit(metrics.processes) : null),
    [metrics],
  );
  // The roll-up is attached BEFORE sorting: the columns sort on the figures the
  // row is showing, and those live in the metrics stream rather than on the unit.
  const rows = useMemo(
    () => sortServiceRows(
      shaped.map((service) => ({ service, resources: resourcesFor(service, byUnit) })),
      sortKey,
      sortDir,
    ),
    [shaped, byUnit, sortKey, sortDir],
  );

  const onSort = useCallback((key: ServiceSortKey) => {
    const [nextKey, nextDir] = toggleSort(sortKey, sortDir, key);
    setSortKey(nextKey);
    setSortDir(nextDir);
  }, [sortKey, sortDir]);

  const perform = useCallback(async ({ service, action }: PendingServiceAction) => {
    setPending(null);
    try {
      await runServiceAction(service.scope, service.unit, action);
      toast.success(`${service.unit}: ${action} done`);
      // systemd settles asynchronously, so the next poll is what shows the new
      // state; refreshing now just shortens the wait.
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not ${action} ${service.unit}`);
    }
  }, [refresh]);

  const onAction = useCallback((service: ServiceInfo, action: ServiceAction) => {
    if (needsConfirm(action)) setPending({ service, action });
    else void perform({ service, action });
  }, [perform]);

  if (snapshot && !snapshot.supported) {
    return (
      <div className="p-4 text-sm text-text-subtle" data-testid="sysmon-services">
        This host has no service manager PPM can read.
        {snapshot.warnings.map((w, i) => (
          <p key={i} className="mt-1 text-xs">{w}</p>
        ))}
      </div>
    );
  }

  return (
    // `@container`: the resource columns are dropped on the PANEL's own width,
    // not the viewport's — the System Monitor is a floating window on desktop
    // and is routinely narrower than the screen it sits on.
    <div
      className="h-full flex flex-col min-h-0 @container"
      // Set once here; every row and the header inherit the four templates.
      style={serviceGridCssVars()}
      data-testid="sysmon-services"
      data-row-count={rows.length}
      data-sort-key={sortKey ?? "default"}
      data-sort-dir={sortDir}
    >
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center" role="tablist">
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              data-testid={`sysmon-services-scope-${s}`}
              className={cn(
                "flex-1 md:flex-none min-h-11 px-4 text-sm font-medium transition-colors",
                scope === s
                  ? "text-text-primary border-b-2 border-primary -mb-px"
                  : "text-text-subtle hover:text-text-secondary",
              )}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 p-2">
          <div className="relative flex-1 min-w-[140px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search services"
              aria-label="Search services"
              data-testid="sysmon-service-search"
              className="w-full min-h-11 md:min-h-8 pl-7 pr-2 text-sm rounded-md border border-border bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {SERVICE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              data-testid={`sysmon-service-filter-${f}`}
              className={cn(
                "min-h-11 md:min-h-8 px-3 text-xs rounded-md border transition-colors",
                filter === f ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-surface-hover",
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <p className="px-3 pb-2 text-[11px] text-text-subtle">
          {counts.total} units · {counts.running} running
          {counts.failed > 0 && <span className="text-error"> · {counts.failed} failed</span>}
        </p>
      </div>

      {snapshot && snapshot.warnings.length > 0 && (
        <div className="px-3 py-1.5 text-[11px] text-warning bg-warning/10 border-b border-border shrink-0">
          {snapshot.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        <ServicesHeader sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <div className="divide-y divide-border">
          {loading && <p className="p-4 text-sm text-text-subtle">Listing units…</p>}
          {error && <p className="p-4 text-sm text-error">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="p-4 text-sm text-text-subtle">No units match.</p>
          )}
          {rows.map(({ service, resources }) => (
            <ServiceRow
              key={`${service.scope}:${service.unit}`}
              service={service}
              resources={resources}
              onOpen={setDetails}
              onAction={onAction}
            />
          ))}
        </div>
      </div>

      <ServiceDetailsSheet target={details} onClose={() => setDetails(null)} />
      <ServiceActionConfirm
        pending={pending}
        onConfirm={(p) => void perform(p)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
