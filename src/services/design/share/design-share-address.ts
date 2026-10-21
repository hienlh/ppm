import type { DesignShareAddress } from "../../../shared/design-share-types.ts";
import { readStatus } from "../../supervisor-state.ts";
import { tunnelService } from "../../tunnel.service.ts";
import { getConfigValue } from "../../db.service.ts";
import { resolveTunnelConfig } from "../../named-tunnel/named-tunnel-config.ts";
import { shareAuthEnabled } from "./design-share-link-rules.ts";

/**
 * The public address a share link is reachable at now.
 *
 * Under a supervisor, `status.json` is read directly rather than through
 * `tunnelService.getTunnelUrl()`: that keeps the last URL it saw when the supervisor nulls
 * `shareUrl`, and a link built on it would point at a tunnel that is gone. Without a
 * supervisor the only tunnel is one this server process started itself, which is quick.
 *
 * Cached for {@link ADDRESS_CACHE_MS}, because guest requests read it too.
 */

export const ADDRESS_CACHE_MS = 5000;

export type ShareTunnelAddress = Pick<DesignShareAddress, "kind" | "url" | "warning">;

const NONE: ShareTunnelAddress = { kind: "none", url: null, warning: null };
let cache: { at: number; value: ShareTunnelAddress } | null = null;

/** Alive, or owned by another user (`EPERM`), which is still a running process. */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

function originOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function readTunnelAddress(): ShareTunnelAddress {
  const status = readStatus();
  if (pidAlive(status.supervisorPid)) {
    const warning = typeof status.tunnelWarning === "string" && status.tunnelWarning ? status.tunnelWarning : null;
    const url = originOf(status.shareUrl);
    // A recorded tunnel process that has died means the URL answers nothing.
    if (!url || (status.tunnelPid != null && !pidAlive(status.tunnelPid))) return { ...NONE, warning };
    return { kind: status.tunnelMode === "named" ? "named" : "quick", url, warning };
  }
  const url = originOf(tunnelService.getTunnelUrl());
  if (url && pidAlive(tunnelService.getTunnelPid())) return { kind: "quick", url, warning: null };
  return NONE;
}

/** Kind, origin and warning of the current public address (cached). */
export function getShareTunnelAddress(now = Date.now()): ShareTunnelAddress {
  if (cache && now - cache.at < ADDRESS_CACHE_MS) return cache.value;
  const value = readTunnelAddress();
  cache = { at: now, value };
  return value;
}

/** The address plus the two switches the Share dialog needs, which are read live. */
export function getShareAddress(): DesignShareAddress {
  return {
    ...getShareTunnelAddress(),
    enabled: resolveTunnelConfig(getConfigValue("tunnel")).enabled,
    authEnabled: shareAuthEnabled(),
  };
}

/** Forget the cached address (tests). */
export function resetShareAddressCache(): void {
  cache = null;
}
