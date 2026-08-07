/**
 * Candidate selection for idle tab prefetching.
 *
 * Pure and DOM-free so the policy is unit-testable (same reason
 * tab-pool-collect.ts exists). The hook that consumes this only handles
 * scheduling.
 */
import type { Panel } from "@/stores/panel-utils";

/** Only chat tabs are prefetched. See pickPrefetchCandidates for why. */
const PREFETCHABLE_TYPE = "chat";

/**
 * Tabs worth warming during idle time, most-recently-used first.
 *
 * Restricted to chat tabs on purpose. They are the expensive ones (history +
 * per-tab metadata) AND they are side-effect free to mount. Terminals must never
 * be prefetched — mounting one spawns a PTY process, so prefetching would start
 * real processes the user never asked for. Editors and DB viewers are similar:
 * cheap to open on demand and not worth speculative I/O.
 *
 * Recency comes from `panel.tabHistory`, which persists in the saved layout with
 * the active tab last. Panels are visited round-robin so a split does not let a
 * tab-heavy panel consume the entire budget.
 */
export function pickPrefetchCandidates(
  panels: Record<string, Panel>,
  mounted: Set<string>,
  cap: number,
): string[] {
  if (cap <= 0) return [];

  // Per-panel queues of prefetchable tab ids, most recent first.
  const queues: string[][] = [];
  for (const panel of Object.values(panels)) {
    const typeById = new Map(panel.tabs.map((t) => [t.id, t.type]));
    const seen = new Set<string>();
    const queue: string[] = [];
    // Legacy/server-merged layouts can lack tabHistory entirely.
    const history = panel.tabHistory ?? [];
    // tabHistory is oldest→newest; walk backwards for most-recent-first.
    for (let i = history.length - 1; i >= 0; i--) {
      const id = history[i]!;
      if (seen.has(id) || mounted.has(id)) continue;
      if (typeById.get(id) !== PREFETCHABLE_TYPE) continue;
      seen.add(id);
      queue.push(id);
    }
    if (queue.length > 0) queues.push(queue);
  }

  const picked: string[] = [];
  const takenIds = new Set<string>();
  for (let round = 0; picked.length < cap; round++) {
    let progressed = false;
    for (const queue of queues) {
      if (picked.length >= cap) break;
      const id = queue[round];
      if (id === undefined) continue;
      progressed = true;
      if (takenIds.has(id)) continue; // same tab id in two panels' histories
      takenIds.add(id);
      picked.push(id);
    }
    if (!progressed) break;
  }
  return picked;
}
