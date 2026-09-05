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

/**
 * True when `key` is a secret key or a dotted descendant of one (e.g. a
 * caller requesting `tunnel.namedTunnelToken.raw` would still be blocked).
 */
export function isSecretConfigKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.some((entry) => key === entry || key.startsWith(`${entry}.`));
}
