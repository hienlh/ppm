/**
 * The cosmetic `ppm` flag: PPM's roots (server + supervisor/parent), every
 * descendant of those roots, and the app share tunnel. Drives the "PPM only"
 * filter in the UI. It is NOT a safety mechanism — the kill guard walks the
 * ppid maps itself and never keys off this flag.
 */
import { collectDescendants } from "./kill-guard.ts";

export interface PpmOwnershipInput {
  roots: ReadonlySet<number>;
  /** Extra pids owned outright (the share tunnel, preview tunnels). */
  extraPids: readonly number[];
  ppidOf: ReadonlyMap<number, number>;
  startedAtOf: ReadonlyMap<number, number>;
}

/**
 * Descendants follow ppid links only while the parent started no later than
 * the child — Windows never clears a dead parent's ppid reference, so an
 * unguarded walk would adopt whatever unrelated process later reused that pid.
 */
export function computePpmPids(input: PpmOwnershipInput): Set<number> {
  const out = new Set<number>();
  const ctx = { ppidOf: input.ppidOf, startedAtOf: input.startedAtOf };
  for (const root of input.roots) {
    if (!input.ppidOf.has(root)) continue;
    out.add(root);
    for (const pid of collectDescendants(root, ctx)) out.add(pid);
  }
  for (const pid of input.extraPids) {
    if (input.ppidOf.has(pid)) out.add(pid);
  }
  return out;
}
