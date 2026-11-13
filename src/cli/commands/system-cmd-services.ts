import type { Command } from "commander";
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServiceInfo, ServiceScope, ServicesSnapshot,
} from "../../types/system-services.ts";
import { SERVICE_ACTIONS } from "../../types/system-services.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";
import { systemRequest } from "./system-cmd-request.ts";

/**
 * `ppm system services` and `ppm system service`: the Services page, through its routes — so an
 * action PPM refuses there (PPM's own unit or job, the OS's own) is refused here with the same
 * words. systemd units on Linux, launchd jobs on macOS, services on Windows.
 */

/** The Services row a scope flag pair names; both or neither means every scope. */
function scopeFilter(opts: { user?: boolean; system?: boolean }): ServiceScope | null {
  if (opts.user && !opts.system) return "user";
  if (opts.system && !opts.user) return "system";
  return null;
}

export function pickServices(rows: readonly ServiceInfo[], scope: ServiceScope | null, filter?: string): ServiceInfo[] {
  const needle = filter?.trim().toLowerCase();
  return rows.filter((s) => (!scope || s.scope === scope)
    && (!needle || s.unit.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)));
}

const stateOf = (s: ServiceInfo) => (s.subState ? `${s.activeState} (${s.subState})` : s.activeState);

function printDetails(d: ServiceDetails, withLog: boolean): void {
  const rows: Array<[string, string | number | null | undefined]> = [
    ["Name", d.unit], ["Scope", d.scope], ["About", d.description], ["State", stateOf(d)],
    ["At boot", d.unitFileState ?? (d.enabled ? "enabled" : "—")], ["Main PID", d.mainPid],
    ["User", d.user], ["Defined in", d.fragmentPath], ["Last exit", d.lastExit],
  ];
  for (const [label, value] of rows) if (value !== undefined) console.log(`${label.padEnd(11)}${value ?? "—"}`);
  if (d.refused) for (const [action, why] of Object.entries(d.refused)) console.log(`${C.dim}${action}: ${why}${C.reset}`);
  if (!withLog) return void console.log(`${C.dim}${d.logs.length} log lines; --log prints them.${C.reset}`);
  for (const line of d.logs) console.log(`${line.ts ? `${new Date(line.ts).toLocaleString()}  ` : ""}${line.message}`);
}

const servicePath = (scope: ServiceScope, unit: string, action?: ServiceAction) =>
  `/services/${scope}/${encodeURIComponent(unit)}${action ? `/${action}` : ""}`;

export function registerSystemServiceCommands(system: Command): void {
  system
    .command("services")
    .description("List services (systemd units, launchd jobs, Windows services)")
    .option("--user", "Only the user's own")
    .option("--system", "Only the machine's")
    .option("--filter <text>", "Only names or descriptions containing this")
    .option("--json", "Print JSON")
    .action((opts: { user?: boolean; system?: boolean; filter?: string; json?: boolean }) => run(async () => {
      const snapshot = await systemRequest<ServicesSnapshot>("GET", "/services");
      if (!snapshot.supported) fail(`PPM cannot read ${snapshot.manager} on this machine${snapshot.warnings[0] ? `: ${snapshot.warnings[0]}` : ""}`);
      const rows = pickServices(snapshot.services, scopeFilter(opts), opts.filter);
      if (opts.json) return void console.log(JSON.stringify({ manager: snapshot.manager, services: rows, warnings: snapshot.warnings }, null, 2));
      printTable(["Name", "Scope", "State", "At boot", "PID"], rows.map((s) => [
        s.unit, s.scope, stateOf(s), s.unitFileState ?? (s.enabled ? "enabled" : "—"), s.mainPid ? String(s.mainPid) : "",
      ]));
      for (const w of snapshot.warnings) console.log(`${C.yellow}! ${w}${C.reset}`);
    })());

  system
    .command("service <nameOrAction> [name]")
    .description(`Show a service, or run ${SERVICE_ACTIONS.join("|")} on it: \`service <name>\`, \`service stop <name>\``)
    .option("--user", "The user's own service rather than the machine's")
    .option("--log", "Print its recent log lines too")
    .option("--json", "Print JSON")
    .action((first: string, second: string | undefined, opts: { user?: boolean; log?: boolean; json?: boolean }) => run(async () => {
      const scope: ServiceScope = opts.user ? "user" : "system";
      if (second === undefined) {
        const details = await systemRequest<ServiceDetails>("GET", servicePath(scope, first));
        if (opts.json) return void console.log(JSON.stringify(details, null, 2));
        return printDetails(details, opts.log === true);
      }
      if (!SERVICE_ACTIONS.includes(first as ServiceAction)) fail(`Action must be one of ${SERVICE_ACTIONS.join(", ")}`);
      const done = await systemRequest<ServiceActionResult>("POST", servicePath(scope, second, first as ServiceAction), {});
      if (opts.json) return void console.log(JSON.stringify(done, null, 2));
      console.log(`${C.green}✓${C.reset} ${done.action} ${done.scope}/${done.unit}${done.note ? ` — ${done.note}` : ""}`);
    })());
}
