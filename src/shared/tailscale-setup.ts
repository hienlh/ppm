/**
 * The Tailscale settings pane's view of the host: what is set up, what is missing, and
 * whether PPM answers at its private address `https://<name>.<tailnet>.ts.net`.
 *
 * That address is a Tailscale Service (`svc:<name>`), not the machine's own name: it
 * stays the same when the machine is renamed, and Tailscale only lets a *tagged* device
 * host one, after an admin approved it as the host.
 */

/** tailscaled's own state names, plus the two PPM can only infer from the CLI failing. */
export type TailscaleBackendState =
  | "NoState" | "NeedsLogin" | "NeedsMachineAuth" | "Stopped" | "Starting" | "Running";

export interface TailscaleServiceState {
  /** The service's name without `svc:`; also the first label of its address. */
  name: string;
  /** `https://<name>.<tailnet suffix>/`, or null while the tailnet's DNS suffix is unknown. */
  url: string | null;
  /** The tailnet has a service by this name that this device can see. */
  defined: boolean;
  /** An admin approved this device as the service's host. */
  approved: boolean;
  /** This device offers to host it (cleared by `tailscale serve drain`). */
  advertised: boolean;
  /** Where the service's HTTPS handler on 443 sends requests, e.g. `http://127.0.0.1:3210`. */
  target: string | null;
  /** That target is this PPM's port on this machine. */
  pointsAtPpm: boolean;
}

export interface TailscaleSetupState {
  /** The CLI was found. */
  installed: boolean;
  /** null: the CLI could not reach tailscaled (not running, or no permission to ask). */
  backendState: TailscaleBackendState | null;
  /**
   * Whether PPM may change Tailscale's settings. Only Linux can say no: there tailscaled
   * takes changes from root and from the one user named as its operator. null: unknown.
   */
  canManage: boolean | null;
  /** The OS account PPM runs as, for the operator command. */
  osUser: string;
  platform: string;
  tailnet: string | null;
  /** The tailnet's MagicDNS suffix, e.g. `tail1234.ts.net`. */
  dnsSuffix: string | null;
  magicDns: boolean;
  /** HTTPS certificates are on in the tailnet, which every `https://…ts.net` address needs. */
  httpsCertificates: boolean;
  device: { name: string; dnsName: string; ips: string[]; tags: string[] } | null;
  service: TailscaleServiceState;
  /** PPM's own switch. */
  enabled: boolean;
  /** The port PPM answers on, which the service should point at. */
  ppmPort: number;
}

export type TailscaleLoginState =
  | "idle" | "starting" | "waiting" | "success" | "needs-approval" | "needs-operator" | "timeout" | "cancelled" | "error";

export interface TailscaleLoginSnapshot {
  state: TailscaleLoginState;
  /** The sign-in link, while waiting for it to be used. */
  url: string | null;
  message: string | null;
}

/** `GET /api/tailscale/state`: the host's setup plus what only PPM knows. */
export interface TailscaleSettingsState extends TailscaleSetupState {
  login: TailscaleLoginSnapshot;
  /** PPM's password is on, which turning the address on requires. */
  authEnabled: boolean;
}

/**
 * The setup steps, in the order the pane walks them. `start` exists only while tailscaled
 * cannot be reached; `operator` can only be missing on Linux.
 */
export type TailscaleStepId = "install" | "start" | "operator" | "sign-in" | "dns" | "tag" | "service";

/** The first step not yet done, or null once all are. */
export function currentSetupStep(s: TailscaleSetupState): TailscaleStepId | null {
  if (!s.installed) return "install";
  if (s.backendState === null) return "start";
  // Before signing in: on Linux `tailscale up` is itself a change tailscaled may refuse.
  if (s.canManage === false) return "operator";
  if (s.backendState !== "Running") return "sign-in";
  if (!s.magicDns || !s.httpsCertificates) return "dns";
  if (!s.device?.tags.length) return "tag";
  if (!s.service.defined) return "service";
  return null;
}

/**
 * The step that stops the switch, or null. Creating the service does not: an admin can only
 * approve a host that already offers it, so the switch comes before approval.
 */
export function blockingSetupStep(s: TailscaleSetupState): Exclude<TailscaleStepId, "service"> | null {
  const step = currentSetupStep(s);
  return step === "service" ? null : step;
}

/** A Tailscale Service name is one DNS label (`tailcfg.ServiceName.Validate`); PPM also wants lowercase. */
export const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const DEFAULT_SERVICE_NAME = "ppm";

/** Why `name` cannot be a service name, or null when it can. */
export function serviceNameProblem(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.length > 63) return "Use at most 63 characters.";
  if (!SERVICE_NAME_PATTERN.test(name)) return "Use lowercase letters, digits and dashes, starting and ending with a letter or digit.";
  return null;
}

export function serviceUrl(name: string, dnsSuffix: string | null): string | null {
  return dnsSuffix ? `https://${name}.${dnsSuffix}/` : null;
}

/** Where the pane sends people for each step done in Tailscale's admin console. */
export const TAILSCALE_ADMIN = {
  dns: "https://login.tailscale.com/admin/dns",
  accessControls: "https://login.tailscale.com/admin/acls/file",
  machines: "https://login.tailscale.com/admin/machines",
  services: "https://login.tailscale.com/admin/services",
} as const;
