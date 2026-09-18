/** Service-manager contract shared by the systemd collector, the routes and the web
 *  client — Mission Center's Services page. Types + constants only, no imports, so
 *  both bundles can take it. Import RELATIVELY — the "@" alias points at src/web. */

export type ServiceScope = "system" | "user";

/** Start/Stop/Restart are Mission Center's menu; Enable/Disable its details switch. */
export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";

export const SERVICE_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart", "enable", "disable"];

/** One unit. Mission Center lists `.service`, `.socket` and `.mount` units and drops
 *  the ones systemd reports as `not-found`; masked units stay in the list. */
export interface ServiceInfo {
  /** Full unit name, suffix included: "sshd.service", "docker.socket", "home.mount". */
  unit: string;
  scope: ServiceScope;
  description: string;
  /** systemd ActiveState verbatim: "active", "inactive", "failed", "activating", … */
  activeState: string;
  /** systemd SubState verbatim: "running", "exited", "dead", "listening", … */
  subState: string;
  /** Unit-file state verbatim ("enabled", "disabled", "static", "masked", "indirect", …);
   *  null for a unit with no unit file (transient, generated without one). */
  unitFileState: string | null;
  /** Mission Center's three booleans, derived exactly as it does: ActiveState "active",
   *  ActiveState "failed", and unit-file state exactly "enabled" (static/indirect/alias
   *  count as not enabled). `activating`/`reloading` are neither running nor failed. */
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
  /** False when the host has no supported service manager (no systemd). The UI hides
   *  the Services page, as Mission Center does when both lists stay empty. */
  supported: boolean;
  services: ServiceInfo[];
  /** Non-fatal failures, human readable (e.g. the user manager is unreachable). */
  warnings: string[];
}

export interface ServiceLogLine {
  /** Epoch ms UTC. */
  ts: number;
  message: string;
}

export interface ServiceDetails extends ServiceInfo {
  /** Configured `User=` / `Group=`; null when unset (runs as the manager's user). */
  user: string | null;
  group: string | null;
  /** Unit file location (`FragmentPath`), null when unknown. */
  fragmentPath: string | null;
  /** This boot's journal for the unit, oldest first, bounded. */
  logs: ServiceLogLine[];
}

export interface ServiceActionResult {
  unit: string;
  scope: ServiceScope;
  action: ServiceAction;
}

/** Client poll cadence while the Services page is visible. The list costs a handful of
 *  `systemctl` spawns, so it is fetched on demand rather than riding the metrics tick. */
export const SERVICES_POLL_INTERVAL_MS = 3000;
