/**
 * The share host as the server sees it: what the user asked for (the `share_host` row) and what
 * runs (the supervisor's status.json: worker pid, connector pid, address, warning).
 *
 * Only the supervisor runs a share host. Without one (a dev server) the settings are kept and
 * nothing is published, which `supervised: false` says.
 */
import { readStatus } from "../supervisor-state.ts";
import type { ResolvedShareHostConfig, ShareHostMode } from "./share-host-config.ts";

/** Alive, or owned by another user (`EPERM`), which is still a running process. */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** The origin of an http(s) URL, or null. */
export function originOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export const NOT_SUPERVISED_MESSAGE = "Review addresses run under `ppm start`; this PPM was started without it.";
export const OUTDATED_SUPERVISOR_MESSAGE =
  "This PPM was started before review addresses existed. Run `ppm restart` to apply.";

/**
 * Why settings saved now would not reach a share host, or null when the running supervisor
 * applies them: there is none, or it predates the `reshare` command.
 */
export function shareHostApplyProblem(status: Record<string, unknown> = readStatus()): string | null {
  if (!pidAlive(status.supervisorPid)) return NOT_SUPERVISED_MESSAGE;
  const capabilities = Array.isArray(status.capabilities) ? (status.capabilities as unknown[]) : [];
  return capabilities.includes("reshare") ? null : OUTDATED_SUPERVISOR_MESSAGE;
}

export interface ShareHostLive {
  enabled: boolean;
  mode: ShareHostMode;
  hostname: string | null;
  /** A supervisor runs, so the settings are acted on. */
  supervised: boolean;
  /** The worker process runs. */
  running: boolean;
  /** Its connector is up: reviewers can open `url` now. */
  connected: boolean;
  /** Where review links open: the live address, or a stable hostname that is momentarily down. */
  url: string | null;
  warning: string | null;
}

export function readShareHostLive(
  config: ResolvedShareHostConfig, status: Record<string, unknown> = readStatus(),
): ShareHostLive {
  const supervised = pidAlive(status.supervisorPid);
  const running = config.enabled && supervised && pidAlive(status.shareHostPid);
  const liveUrl = running && pidAlive(status.shareHostTunnelPid) ? originOf(status.shareHostUrl) : null;
  // A domain does not change while it reconnects, so links keep naming it; a quick address does.
  const stableUrl = config.mode !== "quick" && config.hostname ? `https://${config.hostname}` : null;
  const warning = typeof status.shareHostWarning === "string" && status.shareHostWarning ? status.shareHostWarning : null;
  return {
    enabled: config.enabled,
    mode: config.mode,
    hostname: config.hostname,
    supervised,
    running,
    connected: liveUrl !== null,
    url: config.enabled ? liveUrl ?? stableUrl : null,
    warning: config.enabled ? warning : null,
  };
}
