/**
 * Hostname shape rules for the named tunnel.
 *
 * Exactly one label above the zone, never the apex, never `www`. Two reasons,
 * not just a rule to copy: `cloudflared route dns` never errors on a hostname
 * outside the zone — it silently appends the zone instead (e.g. asking for
 * `ppm-probe.ppm.sh` under zone `hienle.tech` creates `ppm-probe.ppm.sh.hienle.tech`),
 * so PPM must refuse before calling it; and Cloudflare's free Universal SSL
 * certificate only covers one level of subdomain, so a deeper label parses fine
 * here but serves a TLS error to every visitor.
 */

export type HostnameCheck = { ok: true } | { ok: false; reason: string };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

/** Default proposal shown to the user: `ppm.<zone>`. */
export function proposeHostname(zone: string): string {
  return `ppm.${zone.trim().toLowerCase()}`;
}

/** Combine a user-typed prefix with the pinned zone. */
export function buildHostname(prefix: string, zone: string): string {
  return `${prefix.trim().toLowerCase()}.${zone.trim().toLowerCase()}`;
}

export function validateHostname(hostname: string, zone: string): HostnameCheck {
  const host = hostname.trim().toLowerCase();
  const z = zone.trim().toLowerCase();
  if (!host || !z) return { ok: false, reason: "hostname and zone are required" };
  if (host.length > MAX_HOSTNAME_LENGTH) return { ok: false, reason: "hostname exceeds 253 characters" };

  if (host === z) {
    return { ok: false, reason: "hostname cannot be the zone apex — a PPM token must never rewrite the zone's own record" };
  }
  if (host === `www.${z}`) {
    return { ok: false, reason: "www is reserved" };
  }
  if (!host.endsWith(`.${z}`)) {
    return { ok: false, reason: `hostname must be a subdomain of ${z} — cloudflared silently mis-routes anything else` };
  }

  // Everything above the zone must be exactly one label — Cloudflare's free
  // certificate only covers one level, and a deeper label serves a TLS error.
  const prefix = host.slice(0, host.length - z.length - 1);
  if (prefix.includes(".")) {
    return { ok: false, reason: "hostname must be exactly one label above the zone" };
  }

  for (const label of host.split(".")) {
    if (!LABEL.test(label)) {
      return { ok: false, reason: `invalid DNS label: "${label}"` };
    }
  }

  return { ok: true };
}
