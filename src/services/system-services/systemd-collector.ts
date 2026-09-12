/**
 * The Services page's backend: TWO `systemctl` spawns for a whole scope's list,
 * one more for a unit's details, one `journalctl` for its log.
 *
 * Two traps, both found against a real host and both load-bearing:
 *
 *  - A unit name may begin with a dash. The root mount is literally `-.mount`,
 *    so every call that takes unit names passes them after `--`, or systemctl
 *    reads the name as an option bundle and the whole call fails.
 *  - An action without `--no-ask-password` can BLOCK on a polkit prompt nobody
 *    can answer, turning "stop this unit" into a wedged request until the
 *    timeout. PPM is not root, so a system-scope action is expected to be
 *    refused by systemd; it must be refused quickly and reported plainly.
 */
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServiceInfo, ServiceLogLine,
  ServiceScope, ServicesSnapshot,
} from "../../types/system-services.ts";
import type { RunResult, Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { realLinuxFs } from "../system-metrics/linux-fs.ts";
import {
  keepUnit, parseJournalJson, parseListUnits, parseShowBlock, parseShowRecords,
  SHOW_DETAIL_PROPERTIES, SHOW_PROPERTIES, toServiceInfo, type ListUnitsRow,
} from "./systemd-parse.ts";
import { checkServiceActionAllowed, serviceRefusals, type ServiceGuardContext } from "./service-guard.ts";

export const SYSTEMCTL_TIMEOUT_MS = 10_000;
/** An action may legitimately take a while; a stop waits for the unit to settle. */
export const ACTION_TIMEOUT_MS = 20_000;
export const MAX_LOG_LINES = 200;

export const SCOPES: readonly ServiceScope[] = ["system", "user"];

export function systemctlArgv(scope: ServiceScope, args: readonly string[]): string[] {
  return scope === "user" ? ["systemctl", "--user", ...args] : ["systemctl", ...args];
}

/** `--unit=<name>` rather than `--unit <name>`: see the dash trap above. */
export function journalctlArgv(scope: ServiceScope, unit: string, lines: number): string[] {
  const argv = ["journalctl"];
  if (scope === "user") argv.push("--user");
  argv.push(
    `--unit=${unit}`, "--boot", `--lines=${lines}`,
    "--no-pager", "--output=json", "--output-fields=MESSAGE",
  );
  return argv;
}

export interface SystemdDeps {
  run: Runner;
  guard: ServiceGuardContext;
}

/** Attaches the refusals this unit carries, from the same function the action
 *  route enforces — so a greyed-out button and a 403 cannot disagree. */
export function withRefusals(info: ServiceInfo, guard: ServiceGuardContext): ServiceInfo {
  const refused = serviceRefusals(info.unit, info.scope, guard);
  return Object.keys(refused).length > 0 ? { ...info, refused } : info;
}

export function failureText(result: RunResult): string {
  if (result.timedOut) return "timed out";
  return result.stderr.trim() || result.stdout.trim() || `exited ${result.code}`;
}

export interface ScopeListing {
  services: ServiceInfo[];
  warnings: string[];
  /** False when this manager did not answer at all (no systemd, no user bus). */
  ok: boolean;
}

export async function listScope(scope: ServiceScope, deps: SystemdDeps): Promise<ScopeListing> {
  const list = await deps.run(systemctlArgv(scope, [
    "list-units", "--type=service,socket,mount", "--all", "--no-legend", "--plain", "--no-pager",
  ]), SYSTEMCTL_TIMEOUT_MS);
  if (list.timedOut || list.code !== 0) {
    return { services: [], warnings: [`${scope} services unavailable: ${failureText(list)}`], ok: false };
  }

  const rows = parseListUnits(list.stdout).filter(keepUnit);
  if (rows.length === 0) return { services: [], warnings: [], ok: true };

  const show = await deps.run(systemctlArgv(scope, [
    "show", `--property=${SHOW_PROPERTIES.join(",")}`, "--no-pager", "--", ...rows.map((r) => r.unit),
  ]), SYSTEMCTL_TIMEOUT_MS);

  const warnings: string[] = [];
  let byId = new Map<string, Record<string, string>>();
  if (show.timedOut || show.code !== 0) {
    // The list still stands: LOAD/ACTIVE/SUB came from `list-units`. Only the
    // unit-file state and the main pid are lost, so the page degrades rather
    // than emptying.
    warnings.push(`${scope} service details unavailable: ${failureText(show)}`);
  } else {
    byId = parseShowRecords(show.stdout);
  }

  const services = rows.map((row) => withRefusals(toServiceInfo(row, scope, byId.get(row.unit)), deps.guard));
  return { services, warnings, ok: true };
}

export async function collectServices(deps: SystemdDeps): Promise<ServicesSnapshot> {
  const listings = await Promise.all(SCOPES.map((scope) => listScope(scope, deps)));
  return {
    // Either manager answering is enough: a container commonly has the system
    // one and no user session, and a headless server the other way round.
    supported: listings.some((l) => l.ok),
    services: listings.flatMap((l) => l.services),
    warnings: listings.flatMap((l) => l.warnings),
  };
}

export async function serviceLogs(
  unit: string,
  scope: ServiceScope,
  deps: SystemdDeps,
  lines: number = MAX_LOG_LINES,
): Promise<ServiceLogLine[]> {
  const result = await deps.run(journalctlArgv(scope, unit, lines), SYSTEMCTL_TIMEOUT_MS);
  // Not gated on the exit code: journalctl exits non-zero for a unit with no
  // entries this boot while still being perfectly healthy.
  if (result.timedOut || !result.stdout.trim()) return [];
  return parseJournalJson(result.stdout);
}

/** Null when the unit does not exist — the route turns that into a 404. */
export async function serviceDetails(
  unit: string,
  scope: ServiceScope,
  deps: SystemdDeps,
): Promise<ServiceDetails | null> {
  const show = await deps.run(systemctlArgv(scope, [
    "show", `--property=${SHOW_DETAIL_PROPERTIES.join(",")}`, "--no-pager", "--", unit,
  ]), SYSTEMCTL_TIMEOUT_MS);
  if (show.timedOut || show.code !== 0) return null;

  const record = parseShowBlock(show.stdout);
  // `show` answers for a unit it has never heard of too, with LoadState=not-found
  // and every other field blank. That is a 404, not a unit with no description.
  if (!record.Id || record.LoadState === "not-found") return null;

  const row: ListUnitsRow = {
    unit: record.Id,
    loadState: record.LoadState ?? "",
    activeState: record.ActiveState ?? "",
    subState: record.SubState ?? "",
    description: record.Description ?? "",
  };
  const info = withRefusals(toServiceInfo(row, scope, record), deps.guard);
  return {
    ...info,
    user: record.User || null,
    group: record.Group || null,
    fragmentPath: record.FragmentPath || null,
    logs: await serviceLogs(record.Id, scope, deps),
  };
}

/** Thrown when PPM's own guard refuses; the route maps it to 403, not 500. */
export class ServiceActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceActionRefused";
  }
}

export function actionFailureText(result: RunResult, scope: ServiceScope): string {
  const text = failureText(result);
  if (/interactive authentication required/i.test(text)) {
    return scope === "system"
      ? "systemd refused: PPM does not run as root, so system units cannot be changed from here"
      : "systemd refused: this action needs an authentication PPM cannot provide";
  }
  return text;
}

export async function runServiceAction(
  unit: string,
  scope: ServiceScope,
  action: ServiceAction,
  deps: SystemdDeps,
): Promise<ServiceActionResult> {
  const verdict = checkServiceActionAllowed(unit, scope, action, deps.guard);
  if (!verdict.allowed) throw new ServiceActionRefused(verdict.reason ?? "Refused");

  const result = await deps.run(
    systemctlArgv(scope, ["--no-ask-password", action, "--no-pager", "--", unit]),
    ACTION_TIMEOUT_MS,
  );
  if (result.timedOut || result.code !== 0) throw new Error(actionFailureText(result, scope));
  return { unit, scope, action };
}

/** PPM's own cgroup, which is what the guard derives its refusals from. */
export function readSelfCgroup(): string | null {
  return realLinuxFs.read("/proc/self/cgroup");
}

export function createSystemdServices(run: Runner = defaultRunner): SystemdDeps {
  return { run, guard: { selfCgroup: readSelfCgroup() } };
}
