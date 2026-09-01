/**
 * Resolves which loopback port the edge forwarder should send traffic to.
 *
 * Split out of `edge-forwarder.ts` so the forwarder file stays about piping
 * bytes and this one stays about trusting (or not trusting) the port it is told.
 *
 * The source of truth is `~/.ppm/.server-port`, written by the server itself
 * the moment it binds — NOT `status.json`. Two reasons:
 *   1. `writeStatus` replaces status.json wholesale at supervisor startup, so a
 *      supervisor restart would blank the target out from under a live edge.
 *   2. The edge is deliberately detached and outlives the supervisor; it must
 *      not depend on the supervisor being alive to know where the server is.
 * The supervisor mirrors the value into `status.json.serverPort` for `ppm
 * status`, but that copy is observability only.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";

/** File the server writes its bound port to. Single writer: the server. */
export const SERVER_PORT_FILE = () => resolve(getPpmDir(), ".server-port");

/** How long a resolved target port is trusted before re-reading from disk. */
const TARGET_CACHE_MS = 1000;

let cachedPort: number | null = null;
let cachedAt = 0;

/**
 * Current server port, or null when it is absent/invalid.
 *
 * The value is validated rather than trusted: anything able to write the file
 * would otherwise be able to redirect all tunnel traffic. Only a plausible port
 * number is accepted, and callers must always dial loopback.
 *
 * Only successful reads are cached — caching a miss would stretch the
 * forwarder's retry loop to one attempt per second during startup, which is
 * exactly when the server is still coming up.
 */
export function resolveTargetPort(now: number = Date.now()): number | null {
  if (cachedPort !== null && now - cachedAt < TARGET_CACHE_MS) return cachedPort;

  let raw: number;
  try {
    const file = SERVER_PORT_FILE();
    if (!existsSync(file)) return null;
    raw = parseInt(readFileSync(file, "utf-8").trim(), 10);
  } catch {
    return null;
  }

  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) return null;

  cachedPort = raw;
  cachedAt = now;
  return cachedPort;
}

/** Drop the memoized target port (tests, and after a known server restart). */
export function _resetTargetCache(): void {
  cachedPort = null;
  cachedAt = 0;
}
