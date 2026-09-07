/**
 * Feature flag gate. A live video+input channel to the host must never be reachable just
 * because the code shipped — default OFF until phase-07 hardening (host-approval prompt,
 * signed input path) lands. Every entry point (REST routes, WS upgrade) checks this
 * independently rather than trusting a single call site.
 */
export function isRemoteDesktopEnabled(): boolean {
  const v = process.env.REMOTE_DESKTOP_ENABLED;
  return v === "1" || v === "true";
}
