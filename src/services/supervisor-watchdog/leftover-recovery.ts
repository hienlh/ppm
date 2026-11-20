/**
 * What a start (`ppm start`, `ppm restart`, the watchdog task) does with what a dead supervisor
 * left running. Pure: liveness and the port's listener are passed in.
 *
 * A supervisor that died — out of memory on 20/11/2026 — leaves its server orphaned, and its
 * detached edge (the public port) and tunnel (the public URL) still working. The start used to
 * kill all of them; the new supervisor then had to spawn a fresh tunnel (a quick tunnel's URL
 * changes) and the port check found the edge on the port and either killed it or gave up with
 * "Port 3214 is already in use". Now only the orphaned server goes: the edge and the tunnel are
 * left for the new supervisor to adopt (`adoptEdge`, `adoptTunnel`, which check identity).
 */

/** The previous run's processes to kill before starting: its supervisor and server, if alive. */
export function leftoverPidsToKill(prev: Record<string, unknown>, alive: (pid: number) => boolean): number[] {
  const out: number[] = [];
  for (const key of ["supervisorPid", "pid"] as const) {
    const p = prev[key];
    if (typeof p === "number" && p > 0 && !out.includes(p) && alive(p)) out.push(p);
  }
  return out;
}

/**
 * Whether the port is held by the previous run's own edge, which the new supervisor will adopt —
 * so "in use" is not a reason to stop or to reclaim it. Only when the recorded edge is alive and is
 * the port's listener: an unknown listener (0) is not taken as the edge.
 */
export function edgeHoldsPort(prev: Record<string, unknown>, alive: (pid: number) => boolean, listener: number): boolean {
  const edge = prev.edgePid;
  return typeof edge === "number" && edge > 0 && listener === edge && alive(edge);
}
