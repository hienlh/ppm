/**
 * Which pids the kill guard must never end: the PPM server, its supervisor (or
 * plain parent), the edge forwarder, the app share tunnel and every per-port
 * preview tunnel PPM spawned.
 *
 * `status.json` is unvalidated disk state — `supervisorPid` is only cleared by
 * a fresh supervisor start, `bun dev:server` has no supervisor at all, and dev
 * and prod share `~/.ppm`. So every candidate is dropped unless it is alive
 * right now, and a cloudflared candidate must also carry the cloudflared image
 * name (a spoofed command line cannot buy protection). A dead or recycled
 * `supervisorPid` therefore counts as absent and the real parent is protected.
 */
import { readStatus } from "../supervisor-state.ts";
import { activeTunnels } from "../../server/routes/tunnel-spawn.ts";

export interface ProtectedPidsInput {
  status: Record<string, unknown>;
  selfPid: number;
  parentPid: number;
  /** Extra cloudflared pids PPM spawned itself (per-port preview tunnels). */
  portTunnelPids: readonly number[];
  isAlive: (pid: number) => boolean;
  /** Lowercased, extension-free image name for a live pid, or undefined. */
  nameOf: (pid: number) => string | undefined;
}

export interface ProtectedPids {
  /** Everything the kill guard refuses outright. */
  pids: Set<number>;
  /** PPM's own roots: server + supervisor/parent. Grouping boundaries and the
   *  seeds of the `ppm` ownership walk. */
  roots: Set<number>;
  /** This server's own pid — lets the UI tell "this server" from another PPM
   *  instance on the same machine (dev next to prod). */
  selfPid: number;
}

function pidOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Images a PPM supervisor / edge forwarder can run as: the Bun runtime, Node,
 *  or the compiled single binary. A live pid with any other image is a
 *  recycled `status.json` entry, not PPM. */
const PPM_IMAGE_NAMES: ReadonlySet<string> = new Set(["bun", "node", "ppm"]);

export function resolveProtectedPids(input: ProtectedPidsInput): ProtectedPids {
  const { status, isAlive, nameOf } = input;
  const roots = new Set<number>([input.selfPid]);
  const isPpmImage = (pid: number) => isAlive(pid) && PPM_IMAGE_NAMES.has(nameOf(pid) ?? "");
  const cloudflared = (pid: number) => isAlive(pid) && nameOf(pid) === "cloudflared";

  const supervisor = pidOf(status.supervisorPid);
  if (supervisor !== null && isPpmImage(supervisor)) roots.add(supervisor);
  else if (input.parentPid > 0 && isAlive(input.parentPid)) roots.add(input.parentPid);

  const pids = new Set<number>(roots);

  const edge = pidOf(status.edgePid);
  if (edge !== null && isPpmImage(edge)) pids.add(edge);

  const tunnel = pidOf(status.tunnelPid);
  if (tunnel !== null && cloudflared(tunnel)) pids.add(tunnel);
  for (const pid of input.portTunnelPids) {
    if (pid > 0 && cloudflared(pid)) pids.add(pid);
  }

  return { pids, roots, selfPid: input.selfPid };
}

/** Live-state wrapper: reads `status.json` and the preview-tunnel registry. */
export function resolveProtectedPidsLive(
  isAlive: (pid: number) => boolean,
  nameOf: (pid: number) => string | undefined,
): ProtectedPids {
  return resolveProtectedPids({
    status: readStatus(),
    selfPid: process.pid,
    parentPid: process.ppid,
    portTunnelPids: [...activeTunnels.values()].map((t) => t.pid),
    isAlive,
    nameOf,
  });
}
