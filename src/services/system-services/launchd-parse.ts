/**
 * `launchctl print` read into the Services page's shapes. Pure: text in, values out.
 *
 * `print` is the one listing that reaches the system domain without root — the
 * legacy `launchctl list` answers for the caller's own domains only — and its
 * `services` block is a line per job: pid, how the last run ended, label. launchd
 * calls none of this output stable, so it is read by shape (a tab-indented
 * `key = value` tree, a block closing on a lone `}` one level out) rather than by
 * line number, and a line that does not fit is skipped rather than guessed at.
 *
 * The middle column is not an exit code. It is `-` for a job that has not exited
 * since launchd loaded it, a number for one that has (negative: the signal that
 * killed it), or a marker in parentheses for an exit launchd caused itself:
 * `(pe)` a pressured exit, i.e. an idle job asked to quit under memory pressure,
 * and `(jt)` a jetsam kill. On this Mac 155 of 446 jobs read `(pe)`. That is
 * macOS reclaiming memory, not 155 failures, which is why the marker is decoded
 * rather than treated as "not zero".
 */
import type { ServiceInfo, ServiceScope } from "../../types/system-services.ts";

export type LaunchdOverride = "enabled" | "disabled";

/** One line of a domain's `services` block. */
export interface DomainJob {
  label: string;
  /** Null when the job has no process (launchd prints 0). */
  pid: number | null;
  /** The middle column verbatim: "-", "0", "1", "-9", "(pe)", "(jt)". */
  status: string;
}

export interface DomainListing {
  jobs: DomainJob[];
  /** launchd's enable/disable overrides for the domain, by label. A label with no
   *  entry has none, and a job is enabled until something disables it. */
  overrides: Map<string, LaunchdOverride>;
}

/** How a job's last run ended, as far as launchd says. */
export type LastExit =
  /** It has not exited since launchd loaded it: running, or not run yet. */
  | { kind: "none" }
  | { kind: "code"; code: number }
  | { kind: "signal"; signal: number }
  /** Asked to quit while idle, under memory pressure: `(pe)`. */
  | { kind: "idle" }
  /** Killed by jetsam, typically for passing its memory limit: `(jt)`. */
  | { kind: "jetsam"; reason?: string }
  /** A marker this code has not met. Shown as launchd printed it, never a failure. */
  | { kind: "other"; text: string };

/**
 * Darwin's numbering, which is not Linux's past 6 (SIGBUS is 10 here, 7 there). A
 * table rather than `os.constants.signals`, so the names do not depend on which
 * OS runs the tests.
 */
const DARWIN_SIGNALS = [
  "", "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE",
  "SIGKILL", "SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGURG",
  "SIGSTOP", "SIGTSTP", "SIGCONT", "SIGCHLD", "SIGTTIN", "SIGTTOU", "SIGIO", "SIGXCPU",
  "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGINFO", "SIGUSR1", "SIGUSR2",
];

/** The signals a deliberate stop sends, which systemd does not count as a failure
 *  either (SIGHUP, SIGINT, SIGPIPE, SIGTERM). A crash signal, and SIGKILL, are one. */
const CLEAN_SIGNALS: ReadonlySet<number> = new Set([1, 2, 13, 15]);

export function signalName(signal: number): string {
  return DARWIN_SIGNALS[signal] || `signal ${signal}`;
}

/** Launch Services' per-launch instances of applications, which the Apps page lists:
 *  `application.com.apple.Terminal.497485692.497485698`. */
export function isAppInstance(label: string): boolean {
  return label.startsWith("application.");
}

/**
 * The lines inside a top-level block — `\t<name> = {` down to its own `\t}` — with
 * the block's two leading tabs removed, or null when there is no such block.
 * Nesting is read from the indentation, not from braces, because an argument can
 * itself end in `{`.
 */
export function topLevelBlock(text: string, name: string): string[] | null {
  const lines = text.split("\n");
  const start = lines.indexOf(`\t${name} = {`);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "\t}") return body;
    if (line.startsWith("\t\t")) body.push(line.slice(2));
    else if (line !== "") return body; // the block ended without its brace
  }
  return body;
}

const SERVICE_LINE = /^\s*(\d+|-)\s+(\S+)\s+(\S.*?)\s*$/;
const OVERRIDE_LINE = /^"(.*)" => (enabled|disabled)\s*$/;

export function parseOverrides(lines: readonly string[] | null): Map<string, LaunchdOverride> {
  const overrides = new Map<string, LaunchdOverride>();
  for (const line of lines ?? []) {
    const m = OVERRIDE_LINE.exec(line);
    if (m) overrides.set(m[1]!, m[2] as LaunchdOverride);
  }
  return overrides;
}

/** `launchctl print <domain>`: its jobs and its overrides. Null when the text has no
 *  `services` block at all, which is launchd changing its output rather than a domain
 *  with no jobs — every domain has some. */
export function parseDomainPrint(text: string): DomainListing | null {
  const services = topLevelBlock(text, "services");
  if (!services) return null;
  const jobs: DomainJob[] = [];
  for (const line of services) {
    const m = SERVICE_LINE.exec(line);
    if (!m) continue;
    const pid = m[1] === "-" ? 0 : Number(m[1]);
    jobs.push({ label: m[3]!, pid: pid > 0 ? pid : null, status: m[2]! });
  }
  return { jobs, overrides: parseOverrides(topLevelBlock(text, "disabled services")) };
}

/** The middle column of a `services` line. */
export function parseLastExit(status: string): LastExit {
  if (status === "-") return { kind: "none" };
  if (status === "(pe)") return { kind: "idle" };
  if (status === "(jt)") return { kind: "jetsam" };
  if (/^-?\d+$/.test(status)) {
    const n = Number(status);
    return n < 0 ? { kind: "signal", signal: -n } : { kind: "code", code: n };
  }
  return { kind: "other", text: status };
}

/** The last exit in words, "" when there is none to speak of. */
export function describeExit(exit: LastExit): string {
  switch (exit.kind) {
    case "none": return "";
    case "code": return `exit code ${exit.code}`;
    case "signal": return `killed by ${signalName(exit.signal)}`;
    case "idle": return "idle exit";
    case "jetsam":
      return exit.reason === "JETSAM_REASON_MEMORY_PERPROCESSLIMIT" ? "killed by jetsam (memory limit)" : "killed by jetsam";
    case "other": return exit.text;
  }
}

/** An exit that means the job did not do what it was for. */
export function isFailedExit(exit: LastExit): boolean {
  switch (exit.kind) {
    case "code": return exit.code !== 0;
    case "signal": return !CLEAN_SIGNALS.has(exit.signal);
    case "jetsam": return true;
    default: return false;
  }
}

/** A job as the Services page shows it, whichever `print` it was read from. The
 *  description is empty: launchd has none. */
export function toLaunchdServiceInfo(
  job: { label: string; pid: number | null; exit: LastExit },
  scope: ServiceScope,
  override: LaunchdOverride | undefined,
): ServiceInfo {
  const running = job.pid !== null;
  return {
    unit: job.label,
    scope,
    description: "",
    activeState: running ? "running" : "not running",
    // A running job's column holds its PREVIOUS run, which says nothing about now.
    subState: running ? "" : describeExit(job.exit),
    unitFileState: override ?? null,
    running,
    failed: !running && isFailedExit(job.exit),
    enabled: override !== "disabled",
    mainPid: job.pid,
  };
}

/** `launchctl print <domain>/<label>`: the job's own `key = value` lines, and its
 *  argument vector. Blocks other than `arguments` are not kept: the environment
 *  especially, which is where a job's secrets live. */
export interface JobPrint {
  fields: Map<string, string>;
  arguments: string[];
}

/** Null when the text is not a job's description (launchd printed an error). */
export function parseJobPrint(text: string): JobPrint | null {
  const lines = text.split("\n");
  const head = lines.findIndex((line) => /^\S.* = \{$/.test(line));
  if (head < 0) return null;
  const fields = new Map<string, string>();
  const args: string[] = [];
  let block: string | null = null;
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "}") break;
    if (line.startsWith("\t\t")) {
      // Only the block's own lines: a deeper one belongs to a dictionary inside it.
      if (block === "arguments" && line[2] !== "\t") args.push(line.slice(2));
      continue;
    }
    if (!line.startsWith("\t")) continue;
    if (line === "\t}") {
      block = null;
      continue;
    }
    const eq = line.indexOf(" = ");
    if (eq < 0) continue;
    const key = line.slice(1, eq);
    const value = line.slice(eq + 3);
    if (value === "{") block = key;
    else if (!fields.has(key)) fields.set(key, value);
  }
  return { fields, arguments: args };
}

/**
 * The last exit as a job's own description gives it. launchd writes a jetsam kill
 * as a reason, a signal as `strsignal` text with the number after a colon
 * ("Killed: 9"), and an exit code on its own — "(never exited)" when there is none.
 */
export function lastExitFromFields(fields: ReadonlyMap<string, string>): LastExit {
  const reason = fields.get("last exit reason");
  if (reason?.startsWith("JETSAM_REASON_")) {
    return reason === "JETSAM_REASON_MEMORY_IDLE_EXIT" ? { kind: "idle" } : { kind: "jetsam", reason };
  }
  const signal = /:\s*(\d+)\s*$/.exec(fields.get("last terminating signal") ?? "");
  if (signal) return { kind: "signal", signal: Number(signal[1]) };
  const code = /^(\d+)/.exec(fields.get("last exit code") ?? "");
  return code ? { kind: "code", code: Number(code[1]) } : { kind: "none" };
}

/** `properties = keepalive | runatload | inferred program` as a set. */
export function jobProperties(fields: ReadonlyMap<string, string>): Set<string> {
  return new Set((fields.get("properties") ?? "").split("|").map((p) => p.trim()).filter(Boolean));
}

/** A positive pid from a `pid = N` line, else null. */
export function pidField(fields: ReadonlyMap<string, string>): number | null {
  const pid = Number(fields.get("pid") ?? "");
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * `ps -o lstart= -p <pid>` → epoch ms: always five tokens of local time,
 * `Wed Sep 30 22:37:57 2026`, a single-digit day padded with a second space.
 */
export function parseLstart(text: string): number | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  const ms = Date.parse(tokens.join(" "));
  return Number.isFinite(ms) ? ms : null;
}
