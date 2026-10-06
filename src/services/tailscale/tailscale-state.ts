/**
 * Everything the Tailscale settings pane shows, read from three CLI calls that change
 * nothing: `status --json`, `debug prefs` and `serve status --json`.
 *
 * Approval is not in the serve config. The CLI itself decides it from the node's
 * capabilities: `CapMap["service-host"]` maps each service this device is an approved host
 * for to its virtual IPs, and `CapMap["services/<name>"]` is present for every service the
 * device can see. A service that is advertised but missing from `service-host` is waiting
 * for an admin ("This machine is configured as a service proxy for svc:…, but approval
 * from an admin is required").
 *
 * `debug prefs` carries the node's private keys (`Config.PrivateNodeKey`, the network-lock
 * key). Only the few fields below are kept; the raw output is never logged or returned.
 */
import { userInfo } from "node:os";
import { hostCli, runJson, type TailscaleCli } from "./tailscale-cli.ts";
import {
  serviceUrl,
  type TailscaleBackendState,
  type TailscaleServiceState,
  type TailscaleSetupState,
} from "../../shared/tailscale-setup.ts";

const BACKEND_STATES: readonly TailscaleBackendState[] = ["NoState", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running"];

export interface ParsedStatus {
  backendState: TailscaleBackendState | null;
  tailnet: string | null;
  dnsSuffix: string | null;
  magicDns: boolean;
  certDomains: string[];
  device: { name: string; dnsName: string; ips: string[]; tags: string[] } | null;
  capMap: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseStatus(json: unknown): ParsedStatus {
  const s = (json && typeof json === "object" ? json : {}) as Record<string, any>;
  const self = s.Self && typeof s.Self === "object" ? s.Self : null;
  const tailnet = s.CurrentTailnet && typeof s.CurrentTailnet === "object" ? s.CurrentTailnet : null;
  const backendState = BACKEND_STATES.includes(s.BackendState) ? (s.BackendState as TailscaleBackendState) : null;
  const dnsName = str(self?.DNSName)?.replace(/\.$/, "") ?? "";
  return {
    backendState,
    tailnet: str(tailnet?.Name),
    dnsSuffix: str(tailnet?.MagicDNSSuffix) ?? str(s.MagicDNSSuffix),
    magicDns: tailnet?.MagicDNSEnabled === true,
    certDomains: strings(s.CertDomains),
    device: self
      ? { name: str(self.HostName) ?? dnsName.split(".")[0] ?? "", dnsName, ips: strings(self.TailscaleIPs), tags: strings(self.Tags) }
      : null,
    capMap: self?.CapMap && typeof self.CapMap === "object" ? self.CapMap : {},
  };
}

export interface ParsedPrefs {
  operatorUser: string | null;
  advertiseServices: string[];
  /** A control server is set, i.e. this node has been signed in before. */
  hasControlUrl: boolean;
}

/** The handful of prefs PPM needs; everything else in `debug prefs`, keys included, is dropped. */
export function parsePrefs(json: unknown): ParsedPrefs {
  const p = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  return {
    operatorUser: str(p.OperatorUser),
    advertiseServices: strings(p.AdvertiseServices),
    hasControlUrl: !!str(p.ControlURL),
  };
}

/** Whether the node's capabilities name this device as an approved host of `svc`. */
export function isApprovedHost(capMap: Record<string, unknown>, svc: string): boolean {
  const entries = capMap["service-host"];
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => {
    const addrs = e && typeof e === "object" ? (e as Record<string, unknown>)[svc] : undefined;
    return Array.isArray(addrs) && addrs.length > 0;
  });
}

export function isServiceVisible(capMap: Record<string, unknown>, name: string): boolean {
  const entry = capMap[`services/${name}`];
  return Array.isArray(entry) && entry.length > 0;
}

/** Where the service's HTTPS handler on 443 proxies `/`, from `serve status --json`. */
export function serviceTarget(serveConfig: unknown, svc: string): string | null {
  const services = (serveConfig as { Services?: Record<string, { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> }> } | null)?.Services;
  const web = services?.[svc]?.Web;
  if (!web) return null;
  for (const [hostPort, site] of Object.entries(web)) {
    if (!hostPort.endsWith(":443")) continue;
    const proxy = site?.Handlers?.["/"]?.Proxy;
    if (typeof proxy === "string" && proxy) return proxy;
  }
  return null;
}

/** `http://127.0.0.1:3210`, `localhost:3210` and `3210` all point at this machine's port 3210. */
export function targetPort(target: string | null): number | null {
  if (!target) return null;
  if (/^\d+$/.test(target)) return Number(target);
  try {
    const url = new URL(/^[a-z+]+:\/\//i.test(target) ? target : `http://${target}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export interface SetupInputs {
  installed: boolean;
  status: unknown | null;
  prefs: unknown | null;
  serveConfig: unknown | null;
  serviceName: string;
  enabled: boolean;
  ppmPort: number;
  platform: string;
  osUser: string;
  /** PPM runs as root, which tailscaled always obeys. */
  isRoot: boolean;
}

/** The pane's state from the three readings; any of them may be missing. */
export function buildSetupState(input: SetupInputs): TailscaleSetupState {
  const status = input.status ? parseStatus(input.status) : null;
  const prefs = input.prefs ? parsePrefs(input.prefs) : null;
  const svc = `svc:${input.serviceName}`;
  const target = input.serveConfig ? serviceTarget(input.serveConfig, svc) : null;
  const dnsSuffix = status?.dnsSuffix ?? null;
  const service: TailscaleServiceState = {
    name: input.serviceName,
    url: serviceUrl(input.serviceName, dnsSuffix),
    defined: status ? isServiceVisible(status.capMap, input.serviceName) || isApprovedHost(status.capMap, svc) : false,
    approved: status ? isApprovedHost(status.capMap, svc) : false,
    advertised: prefs?.advertiseServices.includes(svc) ?? false,
    target,
    pointsAtPpm: targetPort(target) === input.ppmPort,
  };
  const canManage = input.platform !== "linux" || input.isRoot
    ? true
    : prefs ? prefs.operatorUser === input.osUser : null;
  const deviceName = status?.device?.dnsName ?? "";
  return {
    installed: input.installed,
    backendState: status?.backendState ?? null,
    canManage,
    osUser: input.osUser,
    platform: input.platform,
    tailnet: status?.tailnet ?? null,
    dnsSuffix,
    magicDns: status?.magicDns ?? false,
    httpsCertificates: !!deviceName && (status?.certDomains.includes(deviceName) ?? false),
    device: status?.device ?? null,
    service,
    enabled: input.enabled,
    ppmPort: input.ppmPort,
  };
}

function currentOsUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "";
  }
}

/** Read the host's Tailscale setup for `serviceName`. Never throws: a failed reading is a missing one. */
export async function readTailscaleSetup(
  opts: { serviceName: string; enabled: boolean; ppmPort: number },
  cli: TailscaleCli = hostCli(),
): Promise<TailscaleSetupState> {
  const { argv, runner } = cli;
  const [status, prefs, serveConfig] = argv
    ? await Promise.all([
      runJson(runner, [...argv, "status", "--json"]).catch(() => null),
      runJson(runner, [...argv, "debug", "prefs"]).catch(() => null),
      runJson(runner, [...argv, "serve", "status", "--json"]).catch(() => null),
    ])
    : [null, null, null];
  return buildSetupState({
    installed: !!argv,
    status,
    prefs,
    serveConfig,
    ...opts,
    platform: process.platform,
    osUser: currentOsUser(),
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
  });
}
