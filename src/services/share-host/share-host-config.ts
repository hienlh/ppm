/**
 * The share host's settings (`share_host` config row) and the plan the supervisor runs from them.
 *
 * The share host is a public address for design review links that reaches the review pages and
 * nothing else of PPM (`share-host-gateway.ts`). It gets to Cloudflare in one of three ways:
 *
 * - `quick`: its own temporary trycloudflare address, which changes whenever it restarts;
 * - `named`: its own named tunnel on the user's domain (`ppm-share-<host>`);
 * - `shared`: a second hostname on PPM's own named tunnel. While PPM's public link is on, PPM's
 *   connector carries it; while that link is off, the share host runs a connector on the same
 *   tunnel that routes only its own hostname, so PPM itself stays private.
 */
import { hostname as osHostname } from "node:os";
import { basename, resolve } from "node:path";
import { getPpmDir, isIsolatedPpmHome } from "../ppm-dir.ts";
import type { ResolvedTunnelConfig } from "../named-tunnel/named-tunnel-config.ts";

/** Where the worker publishes the port it listens on. Single writer: the worker. */
export const SHARE_HOST_PORT_FILE = () => resolve(getPpmDir(), ".share-host-port");

export type ShareHostMode = "quick" | "named" | "shared";

export interface ResolvedShareHostConfig {
  /** Master switch, off until the user turns it on. */
  enabled: boolean;
  mode: ShareHostMode;
  hostname: string | null;
  /**
   * `named`: the share host's own tunnel. Kept in the row after switching to another mode, as the
   * record that this installation created it; `shared` runs on PPM's tunnel, so null here.
   */
  tunnelName: string | null;
  /** `named` only: the share tunnel's run token. Secret, like PPM's own. */
  token: string | null;
  zoneID: string | null;
  accountID: string | null;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The stored row as something to act on. A `named` row missing any part of its identity, or a
 * `shared` row with no hostname, is `quick`: setup writes those fields only once it has all of
 * them, so this is a hand-edited row, and a temporary address is what it can still have.
 */
export function resolveShareHostConfig(raw: unknown): ResolvedShareHostConfig {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  const enabled = obj?.enabled === true;
  const quick: ResolvedShareHostConfig = {
    enabled, mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null,
  };
  if (!obj) return quick;
  const ids = { zoneID: nonEmpty(obj.zoneID) ? obj.zoneID : null, accountID: nonEmpty(obj.accountID) ? obj.accountID : null };
  if (obj.mode === "named" && nonEmpty(obj.hostname) && nonEmpty(obj.token) && ids.zoneID && ids.accountID) {
    return {
      enabled, mode: "named", hostname: obj.hostname, tunnelName: nonEmpty(obj.tunnelName) ? obj.tunnelName : null,
      token: obj.token, ...ids,
    };
  }
  if (obj.mode === "shared" && nonEmpty(obj.hostname)) {
    return { enabled, mode: "shared", hostname: obj.hostname, tunnelName: null, token: null, ...ids };
  }
  return quick;
}

/** What the supervisor runs for the share host. */
export type ShareHostPlan =
  | { kind: "off" }
  /** Its own temporary trycloudflare connector. */
  | { kind: "quick" }
  /** Its own connector on its own named tunnel. */
  | { kind: "named"; hostname: string; token: string }
  /** Its own connector on PPM's named tunnel, routing only the share hostname (PPM's link is off). */
  | { kind: "shared-own"; hostname: string; token: string }
  /** PPM's connector carries the share hostname next to PPM's own (PPM's link is on). */
  | { kind: "shared-ppm"; hostname: string }
  | { kind: "unavailable"; reason: string };

export const SHARED_NEEDS_NAMED_PPM =
  "PPM's public link no longer uses your domain, so the review address on its tunnel is down. Set the review address up again.";

/**
 * `ppmLinkOn` is whether PPM's own connector runs now (its public link switch). The two share
 * one tunnel in `shared` mode and must never run two connectors on it with different routes,
 * because Cloudflare spreads every hostname's requests across a tunnel's connectors.
 */
export function planShareHost(
  share: ResolvedShareHostConfig, ppm: ResolvedTunnelConfig | null, ppmLinkOn: boolean,
): ShareHostPlan {
  if (!share.enabled) return { kind: "off" };
  if (share.mode === "named" && share.hostname && share.token) {
    return { kind: "named", hostname: share.hostname, token: share.token };
  }
  if (share.mode === "shared" && share.hostname) {
    if (!ppm || ppm.mode !== "named" || !ppm.token || !ppm.hostname) {
      return { kind: "unavailable", reason: SHARED_NEEDS_NAMED_PPM };
    }
    if (ppmLinkOn) return { kind: "shared-ppm", hostname: share.hostname };
    return { kind: "shared-own", hostname: share.hostname, token: ppm.token };
  }
  return { kind: "quick" };
}

/**
 * Tunnel name for a `named` share host: PPM's own (`tunnelNameForHost`) with `share-` after the
 * `ppm-` prefix, so the two never collide and the prefix survives the length cap.
 */
export function shareTunnelNameForHost(): string {
  const sanitized = osHostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  let suffix = "";
  if (isIsolatedPpmHome()) {
    const dir = basename(getPpmDir()).toLowerCase().replace(/^\.+/, "").replace(/[^a-z0-9-]/g, "-");
    suffix = dir ? `-${dir}` : "-alt";
  }
  return `ppm-share-${sanitized}${suffix}`.slice(0, 32);
}
