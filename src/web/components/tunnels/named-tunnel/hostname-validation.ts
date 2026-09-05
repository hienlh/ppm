/**
 * Thin client re-export of the server hostname rules, so the prefix field
 * validates instantly without a round trip — and without a second regex that
 * could drift from what the server actually enforces.
 */
export {
  validateHostname,
  buildHostname,
  proposeHostname,
} from "../../../../services/named-tunnel/hostname-rules";
export type { HostnameCheck } from "../../../../services/named-tunnel/hostname-rules";

/** Default prefix proposed to the user — mirrors the server's own `proposeHostname`. */
export const DEFAULT_HOSTNAME_PREFIX = "ppm";
