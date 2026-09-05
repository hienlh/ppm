/**
 * Shared denylist for config keys that must never be echoed back by a
 * config-dump surface (`ppm config get`, the extension RPC `workspace:config:get`,
 * and any future status/masking endpoint). Both consumers keep their own local
 * `getNestedValue` implementation — verified not shared — so this list is the
 * one place the two surfaces stay in sync.
 *
 * Exact-key based, not a blanket group hide: sibling fields like
 * `tunnel.mode` or `tunnel.hostname` stay visible so the UI and
 * `ppm config get tunnel.mode` keep working.
 */
export const SECRET_CONFIG_KEYS: readonly string[] = [
  "tunnel.namedTunnelToken",
  "auth.token",
];

/** Marker shown in place of a redacted secret value. Never the empty string, so a caller can tell "masked" apart from "absent". */
const REDACTED = "[REDACTED]";

/**
 * True when `key` is a secret key or a dotted descendant of one (e.g. a
 * caller requesting `tunnel.namedTunnelToken.raw` would still be blocked).
 */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.some((entry) => key === entry || key.startsWith(`${entry}.`));
}

/**
 * Deep-redacts secret leaves inside a config-dump result. `isSecretConfigKey`
 * alone only catches a request for the secret key itself or a descendant of
 * it — a request for an ANCESTOR (`ppm config get tunnel`, or `auth`) walks
 * right past that check and returns the whole object, `namedTunnelToken`/
 * `token` included. This walks `value`'s own keys, rebuilding the dotted path
 * as it goes, and swaps in the masked marker wherever that path matches the
 * denylist — every other key is copied through unchanged, so the shape of
 * the object a caller gets back never changes, only the secret's value does.
 */
export function redactSecretConfigValue(key: string, value: unknown): unknown {
  if (isSecretConfigKey(key)) return REDACTED;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretConfigValue(key ? `${key}.${k}` : k, v);
    }
    return out;
  }
  return value;
}
