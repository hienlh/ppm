/**
 * Pure half of the Windows Services backend: the PowerShell scripts' output format and
 * how a Win32_Service row reads as a `ServiceInfo`. No I/O here, so it runs under
 * `bun:test` on any OS.
 *
 * Every text field crosses the pipe base64-encoded. A service's name and display name
 * are chosen by whoever installed it, and an embedded newline would otherwise forge a
 * row for another service — or the session's `__END_<id>__` marker.
 */
import type { ServiceInfo, ServiceLogLine } from "../../types/system-services.ts";

export const fromB64 = (s: string | undefined) => (s ? Buffer.from(s, "base64").toString("utf8") : "");
export const toB64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** .NET ticks at the Unix epoch, for event times sent as UTC ticks. */
const EPOCH_TICKS = 621355968000000000n;

/** Win32 exit code 1077: "no attempts to start the service have been made". */
const NEVER_STARTED = 1077;
/** Win32 exit code 1066: the real code is in ServiceSpecificExitCode. */
const SERVICE_SPECIFIC = 1066;

export interface WinServiceRow {
  name: string;
  displayName: string;
  /** "Running", "Stopped", "Start Pending", "Stop Pending", "Paused", … */
  state: string;
  /** "Auto", "Manual", "Disabled", "Boot", "System". */
  startMode: string;
  pid: number | null;
  exitCode: number;
  serviceExitCode: number;
  acceptStop: boolean;
  delayedAutoStart: boolean;
}

/**
 * Names Windows itself depends on. Stopping or disabling one does not fail cleanly —
 * it takes the session down with it (RpcSs, DcomLaunch) or quietly breaks networking,
 * event logging or WMI, which this page itself reads through. Starting one is allowed:
 * it is either already running or needed.
 */
export const CRITICAL_SERVICES = new Set([
  "rpcss", "rpceptmapper", "dcomlaunch", "lsm", "samss", "eventlog", "plugplay", "power",
  "brokerinfrastructure", "systemeventsbroker", "coremessagingregistrar", "schedule",
  "gpsvc", "profsvc", "winmgmt", "bfe", "mpssvc", "windefend", "cryptsvc", "dhcp",
  "dnscache", "nsi", "lanmanworkstation", "audioendpointbuilder", "audiosrv", "themes",
  "usermanager", "staterepository", "tokenbroker",
]);

/** `S` lines from the listing script; malformed lines are skipped, not guessed at. */
export function parseServiceLines(text: string): WinServiceRow[] {
  const rows: WinServiceRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("S\t")) continue;
    const f = raw.split("\t");
    if (f.length < 10) continue;
    const name = fromB64(f[1]);
    if (!name) continue;
    const pid = Number(f[5]);
    rows.push({
      name,
      displayName: fromB64(f[2]),
      state: f[3] ?? "",
      startMode: f[4] ?? "",
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      exitCode: Number(f[6]) || 0,
      serviceExitCode: Number(f[7]) || 0,
      acceptStop: /^true$/i.test(f[8] ?? ""),
      delayedAutoStart: /^true$/i.test(f[9] ?? ""),
    });
  }
  return rows;
}

/** The code a stopped service last exited with, or 0 when it ended cleanly or never ran. */
export function lastExitCode(row: Pick<WinServiceRow, "exitCode" | "serviceExitCode">): number {
  if (row.exitCode === NEVER_STARTED) return 0;
  return row.exitCode === SERVICE_SPECIFIC ? row.serviceExitCode : row.exitCode;
}

/** Startup type in the words Windows' own Services console uses. */
export function startupType(row: Pick<WinServiceRow, "startMode" | "delayedAutoStart">): string {
  switch (row.startMode.toLowerCase()) {
    case "auto": return row.delayedAutoStart ? "automatic (delayed)" : "automatic";
    case "manual": return "manual";
    case "disabled": return "disabled";
    case "boot": return "boot";
    case "system": return "system";
    default: return row.startMode.toLowerCase() || "unknown";
  }
}

export function toWindowsServiceInfo(row: WinServiceRow): ServiceInfo {
  const state = row.state.toLowerCase();
  const running = state === "running";
  const exit = running ? 0 : lastExitCode(row);
  const mode = row.startMode.toLowerCase();
  return {
    unit: row.name,
    scope: "system",
    description: row.displayName,
    activeState: state,
    subState: state === "stopped" && exit !== 0 ? `exit code ${exit}` : "",
    unitFileState: startupType(row),
    running,
    failed: state === "stopped" && exit !== 0,
    enabled: mode === "auto" || mode === "boot" || mode === "system",
    mainPid: row.pid,
  };
}

export const CRITICAL_REFUSAL = "Windows needs this service to keep running";
export const NOT_STOPPABLE_REFUSAL = "Windows reports this service cannot be stopped";

/**
 * The refusal that depends on the NAME alone, so it holds with no listing in hand: an
 * action request can arrive before anyone has opened the page.
 */
export function criticalRefusal(name: string, action: string): string | null {
  if (!CRITICAL_SERVICES.has(name.toLowerCase())) return null;
  return action === "stop" || action === "restart" || action === "disable" ? CRITICAL_REFUSAL : null;
}

/** Which actions PPM refuses for a service, with the reason the menu shows. */
export function windowsRefusals(row: WinServiceRow): ServiceInfo["refused"] {
  const refused: NonNullable<ServiceInfo["refused"]> = {};
  if (CRITICAL_SERVICES.has(row.name.toLowerCase())) {
    const why = CRITICAL_REFUSAL;
    refused.stop = why;
    refused.restart = why;
    refused.disable = why;
  } else if (row.state.toLowerCase() === "running" && !row.acceptStop) {
    // Windows itself would refuse: the service told the SCM it cannot be stopped.
    const why = NOT_STOPPABLE_REFUSAL;
    refused.stop = why;
    refused.restart = why;
  }
  return Object.keys(refused).length > 0 ? refused : undefined;
}

export interface WinServiceExtra {
  pathName: string | null;
  startName: string | null;
  description: string | null;
}

/** The `X` line of the details script. */
export function parseExtraLine(text: string): WinServiceExtra | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("X\t"));
  if (!line) return null;
  const f = line.split("\t");
  const field = (i: number) => fromB64(f[i]) || null;
  return { pathName: field(1), startName: field(2), description: field(3) };
}

/** `E` lines, oldest first (the script emits newest first, as Get-WinEvent does). */
export function parseEventLines(text: string): ServiceLogLine[] {
  const lines: ServiceLogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("E\t")) continue;
    const f = raw.split("\t");
    let ts: number | null = null;
    try {
      ts = Number((BigInt(f[1] ?? "") - EPOCH_TICKS) / 10000n);
    } catch { /* unparseable time: keep the message */ }
    const message = fromB64(f[2]).replace(/\s+$/, "");
    if (message) lines.push({ ts, message });
  }
  return lines.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/** The session's own error marker, written by the bootstrap's catch. */
export function scriptError(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("__ERR__ "));
  return line ? line.slice("__ERR__ ".length).trim() : null;
}

/**
 * A service name may reach PowerShell only as base64, so this is not what keeps the
 * script safe — it keeps the route from accepting things no service is called:
 * path separators, control characters, and the wildcards `-Name` would expand.
 */
export function isPlausibleWindowsServiceName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && !/[\\/\x00-\x1f*?[\]]/.test(name);
}
