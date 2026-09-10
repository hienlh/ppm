/**
 * Feature switch. Remote desktop is ON by default — the viewer itself shows a warning before
 * the first frame is streamed (`remote-desktop-warning-gate.tsx`) and every entry point still
 * sits behind PPM auth. `REMOTE_DESKTOP_ENABLED=0` (or `false`) turns the whole surface off for
 * hosts that never want a live video+input channel reachable, e.g. one exposed on a public
 * tunnel. Every entry point (REST routes, WS upgrade) checks this independently rather than
 * trusting a single call site.
 */
export function isRemoteDesktopEnabled(): boolean {
  const v = process.env.REMOTE_DESKTOP_ENABLED?.trim().toLowerCase();
  return !(v === "0" || v === "false");
}
