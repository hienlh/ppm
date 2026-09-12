/**
 * Which service actions PPM refuses, and why.
 *
 * Mission Center refuses nothing — it asks systemd and lets polkit decide. PPM
 * cannot: it is *inside* one of the units it lists, so "stop ppm.service" would
 * end the request mid-flight and leave the user with no way back in. The refusal
 * is derived from PPM's own cgroup rather than a hardcoded unit name, so it is
 * still right when the unit is renamed, run system-wide, or run under a
 * different user manager.
 *
 * One function produces both the per-row `refused` map and the route's verdict,
 * so a disabled button and a 403 can never disagree.
 */
import type { ServiceAction, ServiceScope } from "../../types/system-services.ts";
import { SERVICE_ACTIONS } from "../../types/system-services.ts";

/** Actions that take a running unit away. `start` and `enable` never do. */
const DISRUPTIVE: readonly ServiceAction[] = ["stop", "restart", "disable"];

/**
 * Units whose loss takes the session or the machine with it. Stopping journald
 * or the message bus is not recoverable from a web UI, and `-.mount` is the root
 * filesystem.
 */
export const CRITICAL_UNITS: readonly string[] = [
  "-.mount",
  "dbus.service",
  "dbus.socket",
  "dbus-broker.service",
  "systemd-journald.service",
  "systemd-journald.socket",
  "systemd-logind.service",
  "systemd-udevd.service",
  "init.scope",
];

export interface ServiceGuardContext {
  /** `/proc/self/cgroup`'s path for PPM itself. Null → only the static list applies. */
  selfCgroup: string | null;
}

/**
 * The unit names on PPM's own cgroup path, innermost last:
 * `/user.slice/user-1000.slice/user@1000.service/app.slice/ppm.service`
 * → `["user@1000.service", "ppm.service"]`.
 *
 * Slices are not returned: they are not one of the three unit types the page
 * lists, so they can never be the target of an action anyway.
 */
export function selfUnitChain(cgroup: string | null): string[] {
  if (!cgroup) return [];
  return cgroup
    .split("/")
    .filter((part) => part.endsWith(".service") || part.endsWith(".scope") || part.endsWith(".socket"));
}

/** Every action this unit refuses, with the reason shown to the user. */
export function serviceRefusals(
  unit: string,
  scope: ServiceScope,
  ctx: ServiceGuardContext,
): Partial<Record<ServiceAction, string>> {
  const refusals: Partial<Record<ServiceAction, string>> = {};
  const chain = selfUnitChain(ctx.selfCgroup);

  if (chain.includes(unit)) {
    const reason = unit === chain[chain.length - 1]
      ? `${unit} is PPM itself — stopping it would end this session`
      : `${unit} is the manager PPM runs under — stopping it would end this session`;
    for (const action of DISRUPTIVE) refusals[action] = reason;
    return refusals;
  }

  if (CRITICAL_UNITS.includes(unit)) {
    const reason = `${unit} is required by the system — PPM will not stop it`;
    for (const action of DISRUPTIVE) refusals[action] = reason;
    return refusals;
  }

  // A user-scope unit named like the system manager cannot exist, so the scope
  // is only carried for the message. Kept in the signature because the route
  // passes it and a future scope-specific rule must not change every call site.
  void scope;
  return refusals;
}

export interface ServiceActionVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkServiceActionAllowed(
  unit: string,
  scope: ServiceScope,
  action: ServiceAction,
  ctx: ServiceGuardContext,
): ServiceActionVerdict {
  if (!SERVICE_ACTIONS.includes(action)) return { allowed: false, reason: `Unknown action "${action}"` };
  // A unit name reaches `systemctl` as one argv element, never a shell string,
  // but it is still bounded here: anything with a slash or whitespace in it is
  // not a unit name and has no business being passed on.
  if (!isPlausibleUnitName(unit)) return { allowed: false, reason: "Not a unit name" };
  const reason = serviceRefusals(unit, scope, ctx)[action];
  return reason ? { allowed: false, reason } : { allowed: true };
}

/** systemd unit names: no slash, no whitespace, bounded length. */
export function isPlausibleUnitName(unit: string): boolean {
  return typeof unit === "string"
    && unit.length > 0
    && unit.length <= 256
    && !/[\s/]/.test(unit)
    && /\.[a-z]+$/.test(unit);
}
