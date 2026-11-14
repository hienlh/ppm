/**
 * When the edge forwarder hands the public port to a fresh copy of itself.
 *
 * Bun 1.3.12 on Windows keeps a fully committed 32 MB block every time an idle JSC helper
 * thread exits (measured: 54 cycles with 11 s gaps gained 7 blocks; the same work with 2 s
 * gaps gained none, and Bun 1.4.4 gained none). The edge is the worst case: a TCP proxy
 * that is idle most of the time and that every upgrade adopts instead of replacing, so one
 * edge reached 5.7 GB of private bytes after 34 hours, 4.6 GB of it in those blocks.
 * Nothing but a new process gives them back.
 *
 * The figure is private bytes (commit), never RSS: the blocks are committed and never
 * touched, so RSS stays low while the machine runs out of commit. Only Windows offers that
 * figure per process here; elsewhere the limit is off rather than guessed from RSS.
 */

/** Overrides the limit in MB; `0` turns recycling off. */
export const EDGE_RECYCLE_MB_ENV = "PPM_EDGE_RECYCLE_MB";
export const DEFAULT_EDGE_RECYCLE_MB = 1536;
/**
 * Open client connections the edge may still hold when it recycles. A browser tab keeps
 * several WebSockets through the edge, so "none at all" would rarely happen while a PPM
 * page is open somewhere; two is the usual overnight count. They are cut, and both the
 * PPM client and cloudflared reconnect.
 */
export const EDGE_RECYCLE_QUIET_CONNECTIONS = 2;
/** How often the edge reads its own private bytes. */
export const EDGE_RECYCLE_CHECK_MS = 60_000;
/** The edge exits with this code after releasing the port, so the supervisor replaces it at once. */
export const EDGE_RECYCLE_EXIT_CODE = 75;

/** The limit in MB, or null when recycling is off (not Windows, or turned off by the env). */
export function edgeRecycleLimitMB(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform !== "win32") return null;
  const raw = env[EDGE_RECYCLE_MB_ENV]?.trim();
  if (!raw) return DEFAULT_EDGE_RECYCLE_MB;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_EDGE_RECYCLE_MB;
  return mb === 0 ? null : Math.round(mb);
}

/** True when a reading is over the limit. An unknown reading is never over it. */
export function edgeOverLimit(privateMB: number | undefined, limitMB: number | null): boolean {
  return limitMB !== null && privateMB !== undefined && privateMB >= limitMB;
}

/** The edge recycles itself only when over the limit and nearly idle. */
export function shouldRecycleEdge(
  privateMB: number | undefined,
  openConnections: number,
  limitMB: number | null,
  quietConnections = EDGE_RECYCLE_QUIET_CONNECTIONS,
): boolean {
  return edgeOverLimit(privateMB, limitMB) && openConnections <= quietConnections;
}
