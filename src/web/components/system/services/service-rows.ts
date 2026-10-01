/**
 * The Services page's list shaping - search, filter, ordering and the header
 * counts. Pure and React-free; relative imports only.
 *
 * Mission Center shows one flat list per scope with a search box. PPM keeps the
 * two scopes as sections because a user unit and a system unit of the same name
 * are different units with very different consequences, and a flat list gives no
 * way to tell them apart.
 */
import type { ServiceInfo, ServiceManager, ServiceScope } from "../../../../types/system-services";

export type ServiceFilter = "all" | "running" | "failed" | "enabled";

export const SERVICE_FILTERS: readonly ServiceFilter[] = ["all", "running", "failed", "enabled"];

export function matchesFilter(service: ServiceInfo, filter: ServiceFilter): boolean {
  switch (filter) {
    case "running": return service.running;
    case "failed": return service.failed;
    case "enabled": return service.enabled;
    default: return true;
  }
}

/** Matches the unit name and the description, which is where a user looks for
 *  "bluetooth" when the unit is called `bluez`. */
export function matchesQuery(service: ServiceInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return service.unit.toLowerCase().includes(needle)
    || service.description.toLowerCase().includes(needle);
}

/**
 * Failed first, then running, then everything else, alphabetically within each
 * band. The point of the page is usually a unit that is not doing what it should,
 * so it must not be hundreds of rows down.
 */
export function compareServices(a: ServiceInfo, b: ServiceInfo): number {
  const band = (s: ServiceInfo) => (s.failed ? 0 : s.running ? 1 : 2);
  const diff = band(a) - band(b);
  return diff !== 0 ? diff : a.unit.localeCompare(b.unit);
}

export function shapeServices(
  services: readonly ServiceInfo[],
  scope: ServiceScope,
  filter: ServiceFilter,
  query: string,
): ServiceInfo[] {
  return services
    .filter((s) => s.scope === scope && matchesFilter(s, filter) && matchesQuery(s, query))
    .sort(compareServices);
}

export interface ServiceCounts {
  total: number;
  running: number;
  failed: number;
}

export function serviceCounts(services: readonly ServiceInfo[], scope?: ServiceScope): ServiceCounts {
  const scoped = scope ? services.filter((s) => s.scope === scope) : services;
  return {
    total: scoped.length,
    running: scoped.filter((s) => s.running).length,
    failed: scoped.filter((s) => s.failed).length,
  };
}

/** The dot beside a row. `activating` and `reloading` are deliberately neither
 *  running nor failed, so they get their own colour rather than borrowing one. */
export type ServiceTone = "failed" | "running" | "busy" | "idle";

export function serviceTone(service: ServiceInfo): ServiceTone {
  if (service.failed) return "failed";
  if (service.running) return "running";
  if (service.activeState === "activating" || service.activeState === "deactivating"
    || service.activeState === "reloading") return "busy";
  return "idle";
}

/** What the row says under the unit name when there is no description. launchd
 *  leaves `subState` empty while a job runs, which is no reason to print "()". */
export function serviceStatusText(service: ServiceInfo): string {
  const state = service.subState ? `${service.activeState} (${service.subState})` : service.activeState;
  return service.unitFileState ? `${state} · ${service.unitFileState}` : state;
}

/**
 * The badge beside the name marks the state that is the exception. Most systemd
 * units are static and only some are enabled, so "enabled" is worth saying. Every
 * launchd job is enabled until something disables it — 414 of the 415 this Mac
 * lists for its user — so there it is "disabled" that stands out.
 */
export function enablementBadge(service: ServiceInfo, manager: ServiceManager): "enabled" | "disabled" | null {
  if (manager === "launchd") return service.enabled ? null : "disabled";
  return service.enabled ? "enabled" : null;
}

/** True when every action is refused, so the row's menu is offered at all. */
export function hasAnyAction(service: ServiceInfo, actions: readonly string[]): boolean {
  return actions.some((a) => service.refused?.[a as keyof typeof service.refused] === undefined);
}
