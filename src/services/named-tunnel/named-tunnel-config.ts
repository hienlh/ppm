/**
 * Runtime resolver: turns the persisted `tunnel` config row into the shape the
 * supervisor and UI actually consume. This is where "incomplete" data degrades
 * to quick — storage (`sanitizeConfig`) never makes that judgment itself, so
 * `/disable`'s documented "keep the config so Retry works" contract survives a
 * config round-trip.
 */

export type TunnelMode = "quick" | "named";

export interface ResolvedTunnelConfig {
  mode: TunnelMode;
  hostname: string | null;
  tunnelName: string | null;
  token: string | null;
  zoneID: string | null;
  accountID: string | null;
  dismissed: boolean;
}

const QUICK: Omit<ResolvedTunnelConfig, "dismissed"> = {
  mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null,
};

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function resolveTunnelConfig(raw: unknown): ResolvedTunnelConfig {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }

  const dismissed = obj != null && typeof obj.dismissed === "boolean" ? obj.dismissed : false;

  // Named mode requires BOTH the stored mode flag AND all four identity fields —
  // checking fields alone would resurrect a tunnel the user explicitly disabled,
  // since /disable intentionally keeps namedTunnel* fields around for Retry.
  const named = obj != null && obj.mode === "named" &&
    nonEmptyString(obj.namedTunnelToken) &&
    nonEmptyString(obj.namedTunnelHostname) &&
    nonEmptyString(obj.zoneID) &&
    nonEmptyString(obj.accountID);

  if (!named || obj == null) {
    return { ...QUICK, dismissed };
  }

  return {
    mode: "named",
    hostname: obj.namedTunnelHostname as string,
    tunnelName: nonEmptyString(obj.namedTunnelName) ? obj.namedTunnelName : null,
    token: obj.namedTunnelToken as string,
    zoneID: obj.zoneID as string,
    accountID: obj.accountID as string,
    dismissed,
  };
}

/** `abcdef...` — first 6 chars + ellipsis; never the full secret. */
export function maskToken(token: string | null): string | null {
  if (token == null) return null;
  return `${token.slice(0, 6)}...`;
}
