/** Service-manager contract shared by the systemd and launchd collectors, the routes
 *  and the web client — Mission Center's Services page. Types + constants only, no
 *  imports, so both bundles can take it. Import RELATIVELY — the "@" alias points at
 *  src/web. */

export type ServiceScope = "system" | "user";

/** systemd on Linux, launchd on macOS, the Service Control Manager ("scm") on Windows.
 *  It decides what the page calls a row (a unit, a job or a service) and how a few
 *  fields read. Under scm every service is in the `system` scope; `activeState` is the
 *  SCM state lower-cased ("running", "stopped", "start pending"), `subState` the last
 *  exit code of a stopped service that failed, `unitFileState` the startup type
 *  ("automatic", "automatic (delayed)", "manual", "disabled"), `enabled` means it starts
 *  at boot, and `fragmentPath` is the service's command line. */
export type ServiceManager = "systemd" | "launchd" | "scm";

/** Start/Stop/Restart are Mission Center's menu; Enable/Disable its details switch. */
export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";

export const SERVICE_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart", "enable", "disable"];

/** One unit. Mission Center lists `.service`, `.socket` and `.mount` units and drops
 *  the ones systemd reports as `not-found`; masked units stay in the list. */
export interface ServiceInfo {
  /** Full unit name, suffix included: "sshd.service", "docker.socket", "home.mount".
   *  Under launchd, the job's label: "com.apple.Finder", "homebrew.mxcl.postgresql@16". */
  unit: string;
  scope: ServiceScope;
  description: string;
  /** systemd ActiveState verbatim: "active", "inactive", "failed", "activating", …
   *  Under launchd, "running" or "not running": launchd has no failed state. */
  activeState: string;
  /** systemd SubState verbatim: "running", "exited", "dead", "listening", …
   *  Under launchd, how the last run ended ("exit code 1", "killed by SIGKILL", "idle
   *  exit"), or "" while the job is running. */
  subState: string;
  /** Unit-file state verbatim ("enabled", "disabled", "static", "masked", "indirect", …);
   *  null for a unit with no unit file (transient, generated without one). Under launchd,
   *  the override launchd holds for the label ("enabled" or "disabled"), null for the
   *  many jobs that have none. */
  unitFileState: string | null;
  /** Mission Center's three booleans, derived exactly as it does: ActiveState "active",
   *  ActiveState "failed", and unit-file state exactly "enabled" (static/indirect/alias
   *  count as not enabled). `activating`/`reloading` are neither running nor failed.
   *
   *  Under launchd: the job has a process; it has none and its last run ended in an
   *  error (an exit code, a crash signal, a jetsam kill); and it is not disabled —
   *  every job is enabled until something disables it. */
  running: boolean;
  failed: boolean;
  enabled: boolean;
  /** Main process, null when the unit has none (stopped, socket, mount, oneshot done). */
  mainPid: number | null;
  /** Actions the guard refuses for this unit, each with the reason shown to the user.
   *  Produced by the same function the action route enforces, so a disabled button
   *  and a 403 cannot disagree. Absent when every action is allowed. */
  refused?: Partial<Record<ServiceAction, string>>;
}

export interface ServicesSnapshot {
  /** False when the host has no service manager PPM can read (the one it asked did not
   *  answer). The UI hides the Services page, as Mission Center does when both lists
   *  stay empty. */
  supported: boolean;
  /** The manager PPM asked: launchd on macOS, systemd everywhere else. */
  manager: ServiceManager;
  services: ServiceInfo[];
  /** Non-fatal failures, human readable (e.g. the user manager is unreachable). */
  warnings: string[];
}

export interface ServiceLogLine {
  /** Epoch ms UTC; null for a line read from a job's own log file, which has none. */
  ts: number | null;
  message: string;
}

/** Where a launchd job's log lines came from. systemd's are always this boot's journal. */
export type ServiceLogSource =
  /** The tail of the files the job sends its stdout and stderr to. */
  | { kind: "files"; paths: string[] }
  /** The unified log, for a job that declares no readable file: everything since the
   *  running process started, or since boot for a job that is not running. */
  | { kind: "unified"; since: "start" | "boot" }
  /** The same cut to a recent window, because the whole of it could not be read in time. */
  | { kind: "unified"; minutes: number };

export interface ServiceDetails extends ServiceInfo {
  /** Configured `User=` / `Group=`; null when unset (runs as the manager's user). Under
   *  launchd, the user the job runs as and its `group`, when launchd reports one. */
  user: string | null;
  group: string | null;
  /** Unit file location (`FragmentPath`), null when unknown. Under launchd, the job's
   *  property list, or launchd's note for a job submitted without one
   *  ("(submitted by smd.95)"). */
  fragmentPath: string | null;
  /** The unit's log, oldest first, bounded: this boot's journal under systemd, and
   *  under launchd whatever `logSource` says. */
  logs: ServiceLogLine[];
  /** launchd only, from here down. */
  logSource?: ServiceLogSource;
  /** The executable launchd runs, and the argument vector it passes (argv[0] first). */
  program?: string | null;
  arguments?: string[];
  stdoutPath?: string | null;
  stderrPath?: string | null;
  /** How the last run ended, in words: "exit code 1", "Killed: 9", "never exited". */
  lastExit?: string | null;
  /** launchd starts the job again whenever it stops, which is why Stop does not last. */
  keepAlive?: boolean;
}

export interface ServiceActionResult {
  unit: string;
  scope: ServiceScope;
  action: ServiceAction;
  /** What the user should know about how it landed: a job launchd keeps alive has
   *  already started again by the time a stop returns. */
  note?: string;
}

/** Client poll cadence while the Services page is visible. The list costs a handful of
 *  `systemctl` / `launchctl` spawns, so it is fetched on demand rather than riding the
 *  metrics tick. */
export const SERVICES_POLL_INTERVAL_MS = 3000;
