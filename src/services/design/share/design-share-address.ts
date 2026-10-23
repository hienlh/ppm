import type { DesignShareAddress } from "../../../shared/design-share-types.ts";
import { readStatus } from "../../supervisor-state.ts";
import { tunnelService } from "../../tunnel.service.ts";
import { getConfigValue } from "../../db.service.ts";
import { resolveTunnelConfig } from "../../named-tunnel/named-tunnel-config.ts";
import { resolveShareHostConfig } from "../../share-host/share-host-config.ts";
import { originOf, pidAlive, readShareHostLive, shareHostApplyProblem } from "../../share-host/share-host-status.ts";
import { shareAuthEnabled } from "./design-share-link-rules.ts";

/**
 * The public address a share link is reachable at now.
 *
 * With the share host switched on, that is the share host's address and nothing else: it
 * reaches the review pages only, and falling back to PPM's own tunnel would hand reviewers an
 * address that reaches all of PPM. A stable hostname is kept while it reconnects, with a
 * warning; a quick one has no address until it is up.
 *
 * Otherwise it is PPM's own tunnel. Under a supervisor, `status.json` is read directly rather
 * than through `tunnelService.getTunnelUrl()`: that keeps the last URL it saw when the
 * supervisor nulls `shareUrl`, and a link built on it would point at a tunnel that is gone.
 * Without a supervisor the only tunnel is one this server process started itself, which is
 * quick.
 *
 * Cached for {@link ADDRESS_CACHE_MS}, because guest requests read it too; the owner's own read
 * ({@link getShareAddress}) is always fresh.
 */

export const ADDRESS_CACHE_MS = 5000;
export const SHARE_HOST_NOT_CONNECTED = "The review address is not connected right now. Links work again once it reconnects.";

export type ShareTunnelAddress = Pick<DesignShareAddress, "kind" | "url" | "warning" | "via">;

const NONE: ShareTunnelAddress = { kind: "none", url: null, warning: null, via: "ppm" };
let cache: { at: number; value: ShareTunnelAddress; hosts: string[] } | null = null;

function readPpmTunnelAddress(status: Record<string, unknown>): ShareTunnelAddress {
  if (pidAlive(status.supervisorPid)) {
    const warning = typeof status.tunnelWarning === "string" && status.tunnelWarning ? status.tunnelWarning : null;
    const url = originOf(status.shareUrl);
    // A recorded tunnel process that has died means the URL answers nothing.
    if (!url || (status.tunnelPid != null && !pidAlive(status.tunnelPid))) return { ...NONE, warning };
    return { kind: status.tunnelMode === "named" ? "named" : "quick", url, warning, via: "ppm" };
  }
  const url = originOf(tunnelService.getTunnelUrl());
  if (url && pidAlive(tunnelService.getTunnelPid())) return { kind: "quick", url, warning: null, via: "ppm" };
  return NONE;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function readAddresses(): { value: ShareTunnelAddress; hosts: string[] } {
  const status = readStatus();
  const ppm = readPpmTunnelAddress(status);
  const shareHost = readShareHostLive(resolveShareHostConfig(getConfigValue("share_host")), status);
  const hosts = [hostOf(ppm.url), hostOf(shareHost.url)].filter((h): h is string => h !== null);
  if (!shareHost.enabled) return { value: ppm, hosts };
  // Down because nothing will ever act on the switch: say that rather than "reconnecting".
  const problem = shareHost.connected ? null : shareHostApplyProblem(status);
  const value: ShareTunnelAddress = shareHost.url
    ? {
        kind: shareHost.mode === "quick" ? "quick" : "named",
        url: shareHost.url,
        warning: shareHost.connected ? shareHost.warning : problem ?? shareHost.warning ?? SHARE_HOST_NOT_CONNECTED,
        via: "share-host",
      }
    : { kind: "none", url: null, warning: problem ?? shareHost.warning, via: "share-host" };
  return { value, hosts };
}

function cached(now: number): { value: ShareTunnelAddress; hosts: string[] } {
  if (cache && now - cache.at < ADDRESS_CACHE_MS) return cache;
  cache = { at: now, ...readAddresses() };
  return cache;
}

/** Kind, origin and warning of the current public address (cached). */
export function getShareTunnelAddress(now = Date.now()): ShareTunnelAddress {
  return cached(now).value;
}

/**
 * The public hostnames whose requests reach PPM through a connector on this machine — PPM's own
 * tunnel and the share host — lower-cased `host[:port]` (cached).
 */
export function getForwardedShareHosts(now = Date.now()): string[] {
  return cached(now).hosts;
}

/**
 * The address plus the two switches the Share dialog needs. Read fresh, past the cache: the
 * dialog asks right after flipping a switch and while an address comes up. What it reads
 * replaces the cached address.
 */
export function getShareAddress(): DesignShareAddress {
  cache = { at: Date.now(), ...readAddresses() };
  return {
    ...cache.value,
    enabled: resolveTunnelConfig(getConfigValue("tunnel")).enabled,
    authEnabled: shareAuthEnabled(),
  };
}

/** Forget the cached address (tests). */
export function resetShareAddressCache(): void {
  cache = null;
}
