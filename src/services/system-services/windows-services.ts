/**
 * The Services page's backend on Windows: the Service Control Manager, read through
 * `Win32_Service` and driven with the Service cmdlets, with each service's log taken
 * from the Event Log.
 *
 * One long-lived PowerShell session, never a spawn per request: the page polls every
 * 3 s, and each `powershell.exe` spawn costs Bun a 32 MiB allocator segment it never
 * returns (see powershell-session.ts). The session runs one request at a time, so
 * requests queue here — a details read or an action arriving mid-poll waits its turn
 * instead of failing with "already in flight".
 *
 * Windows has one service manager, so every service is in the `system` scope. Mapping
 * onto the page's systemd vocabulary:
 *
 * - Stop runs `Stop-Service` without `-Force`, so a service others depend on refuses
 *   rather than taking its dependents down with it unasked.
 * - "Enable" sets the startup type to Automatic, "disable" to Manual — not Disabled.
 *   systemd's disable means "do not start at boot", and Manual is exactly that; Windows'
 *   Disabled also forbids starting it by hand, which nobody pressing "disable at boot"
 *   asked for.
 * - The cmdlets' `-Name` expands wildcards, so the service is looked up by exact name
 *   first and handed over as an object.
 * - Most actions need an elevated PPM. Unelevated, Windows' own "Cannot open … service"
 *   is what the user sees.
 */
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServiceInfo, ServiceScope, ServicesSnapshot,
} from "../../types/system-services.ts";
import { PowerShellSession } from "../system-metrics/powershell-session.ts";
import type { ServiceBackend } from "./service-backend.ts";
import { ServiceActionRefused } from "./systemd-collector.ts";
import {
  criticalRefusal, isPlausibleWindowsServiceName, NOT_STOPPABLE_REFUSAL, parseEventLines, parseExtraLine,
  parseServiceLines, scriptError, toB64, toWindowsServiceInfo, windowsRefusals, type WinServiceRow,
} from "./windows-services-parse.ts";

/** Most services; the event log is bounded below so a details read stays well inside. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 200;

const B64 = (expr: string) => `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${expr})))`;

const SERVICE_LINE =
  `"S\`t$(${B64("$_.Name")})\`t$(${B64("$_.DisplayName")})\`t$($_.State)\`t$($_.StartMode)\`t$($_.ProcessId)` +
  `\`t$($_.ExitCode)\`t$($_.ServiceSpecificExitCode)\`t$($_.AcceptStop)\`t$($_.DelayedAutoStart)"`;

export const LIST_SCRIPT =
  "Get-CimInstance Win32_Service -Property Name,DisplayName,State,StartMode,ProcessId,ExitCode,ServiceSpecificExitCode,AcceptStop,DelayedAutoStart | " +
  `ForEach-Object { ${SERVICE_LINE} }`;

/** `$n` is the service name, decoded from base64: the only way a name enters a script. */
const nameVar = (name: string) => `$n = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toB64(name)}'))`;

export function detailsScript(name: string): string {
  return [
    nameVar(name),
    "$s = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq $n } | Select-Object -First 1",
    "if ($s) {",
    `  $s | ForEach-Object { ${SERVICE_LINE} }`,
    `  "X\`t$(${B64("$s.PathName")})\`t$(${B64("$s.StartName")})\`t$(${B64("$s.Description")})"`,
    "  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime",
    // The SCM names a service by its display name in its own events (7036 "entered the
    // running state", 7034 "terminated unexpectedly"), as the first insertion string.
    // Each query in its own try: Get-WinEvent THROWS ("The parameter is incorrect", "No
    // events were found") rather than answering empty, past -ErrorAction, and one
    // throw would otherwise end the whole script before the other log is read.
    "  $scm = try { Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=$boot} -MaxEvents 5000 -ErrorAction Stop |",
    "    Where-Object { $_.Properties.Count -gt 0 -and (($_.Properties[0].Value -eq $s.DisplayName) -or ($_.Properties[0].Value -eq $n)) } |",
    `    Select-Object -First ${MAX_LOG_LINES} } catch { @() }`,
    // A service that logs for itself registers an event source under its own name.
    `  $own = try { Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=$n; StartTime=$boot} -MaxEvents ${MAX_LOG_LINES} -ErrorAction Stop } catch { @() }`,
    "  @($scm) + @($own) | Where-Object { $_ } | ForEach-Object {",
    `    "E\`t$($_.TimeCreated.ToUniversalTime().Ticks)\`t$(${B64("$_.Message")})"`,
    "  }",
    "}",
  ].join("\n");
}

const ACTION_CMD: Record<ServiceAction, string> = {
  start: "Start-Service -InputObject $svc -ErrorAction Stop",
  stop: "Stop-Service -InputObject $svc -ErrorAction Stop",
  restart: "Restart-Service -InputObject $svc -ErrorAction Stop",
  enable: "Set-Service -InputObject $svc -StartupType Automatic -ErrorAction Stop",
  disable: "Set-Service -InputObject $svc -StartupType Manual -ErrorAction Stop",
};

/**
 * One request that reads the service's state NOW and decides on it, so a decision is
 * never made from a listing that is seconds old (an earlier action, another client, the
 * service crashing by itself). Answers one line: `NOOP running`, `NOOP stopped`,
 * `REFUSED`, or `OK` after the action ran.
 */
export function actionScript(name: string, action: ServiceAction): string {
  // One if/elseif chain, never `return`: the script runs through Invoke-Expression inside
  // the session's own loop, where a `return` leaves the bootstrap and ends the session.
  const branches: string[] = [];
  if (action === "start") branches.push("($state -eq 'Running') { 'NOOP running' }");
  if (action === "stop") branches.push("($state -eq 'Stopped') { 'NOOP stopped' }");
  if (action === "stop" || action === "restart") branches.push("($state -eq 'Running' -and -not $svc.CanStop) { 'REFUSED' }");
  const run = `{ ${ACTION_CMD[action]}; 'OK' }`;
  const chain = branches.length > 0 ? `if ${branches.join(" elseif ")} else ${run}` : `& ${run}`;
  return [
    nameVar(name),
    "$svc = Get-Service | Where-Object { $_.Name -eq $n } | Select-Object -First 1",
    "if (-not $svc) { throw \"No service named $n\" }",
    "$state = [string]$svc.Status",
    chain,
  ].join("\n");
}

/** What the backend needs from PowerShell: run one script, get its output. */
export type PsRunner = (script: string) => Promise<string>;

/** Serialise requests onto one session; a failed request does not block the next. */
export function queuedRunner(session: Pick<PowerShellSession, "request">): PsRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return (script) => {
    const run = tail.then(() => session.request(script));
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createWindowsServicesBackend(run: PsRunner = defaultRunner()): ServiceBackend {
  const withRefusals = (row: WinServiceRow): ServiceInfo => {
    const info = toWindowsServiceInfo(row);
    const refused = windowsRefusals(row);
    return refused ? { ...info, refused } : info;
  };

  return {
    manager: "scm",
    isName: isPlausibleWindowsServiceName,

    async collect(): Promise<ServicesSnapshot> {
      let text: string;
      try {
        text = await run(LIST_SCRIPT);
      } catch (e) {
        return { supported: false, manager: "scm", services: [], warnings: [`services unavailable: ${(e as Error).message}`] };
      }
      const rows = parseServiceLines(text);
      const err = scriptError(text);
      if (rows.length === 0) {
        return { supported: false, manager: "scm", services: [], warnings: [`services unavailable: ${err ?? "no services listed"}`] };
      }
      return {
        supported: true,
        manager: "scm",
        services: rows.map(withRefusals),
        warnings: err ? [`PowerShell: ${err}`] : [],
      };
    },

    async details(name: string, scope: ServiceScope): Promise<ServiceDetails | null> {
      if (scope !== "system") return null;
      const text = await run(detailsScript(name));
      const [row] = parseServiceLines(text);
      const extra = parseExtraLine(text);
      if (!row || !extra) return null;
      return {
        ...withRefusals(row),
        // The SCM's own long description; the row's description is the display name.
        description: extra.description || row.displayName,
        user: extra.startName,
        group: null,
        fragmentPath: extra.pathName,
        logs: parseEventLines(text),
      };
    },

    async action(name: string, scope: ServiceScope, action: ServiceAction): Promise<ServiceActionResult> {
      if (scope !== "system") throw new ServiceActionRefused("Windows services are all system services");
      // By name, before anything else: it must hold whether or not a listing ran first.
      const critical = criticalRefusal(name, action);
      if (critical) throw new ServiceActionRefused(critical);
      const text = await run(actionScript(name, action));
      const err = scriptError(text);
      if (err) throw new Error(err);
      // Nothing to do, so Windows was not asked: unelevated, the SCM refuses even a start
      // of a running service ("Cannot open … service"), which reads as a failure of
      // something that already holds.
      if (/^NOOP running\s*$/m.test(text)) return { unit: name, scope, action, note: `${name} is already running` };
      if (/^NOOP stopped\s*$/m.test(text)) return { unit: name, scope, action, note: `${name} was not running` };
      if (/^REFUSED\s*$/m.test(text)) throw new ServiceActionRefused(NOT_STOPPABLE_REFUSAL);
      if (!/^OK\s*$/m.test(text)) throw new Error("The service did not answer");
      return { unit: name, scope, action };
    },
  };
}

let sharedRunner: PsRunner | null = null;

/** Built on first use, so a server nobody opens the Services page on starts no PowerShell. */
function defaultRunner(): PsRunner {
  return (script) => {
    sharedRunner ??= queuedRunner(new PowerShellSession({ requestTimeoutMs: REQUEST_TIMEOUT_MS }));
    return sharedRunner(script);
  };
}
