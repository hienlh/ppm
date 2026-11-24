/**
 * Process-wide kill switch for PPM's web browser. `WEB_BROWSER_ENABLED=0` (or `false`) removes the
 * whole surface whatever the settings say, for a host that must never run a browser reachable
 * from PPM. Every entry point (routes, WS upgrade, AI tools) checks it on its own, the way
 * `remote-desktop-flag.ts` is checked.
 */
export function isWebBrowserAllowedByEnv(): boolean {
  const v = process.env.WEB_BROWSER_ENABLED?.trim().toLowerCase();
  return !(v === "0" || v === "false");
}
