import type { SidebarActiveTab } from "@/stores/settings-store";

/**
 * Order `available` tabs by the user's `saved` order, reconciling drift:
 * - ids in `saved` that still exist in `available` keep the saved order,
 * - ids in `saved` no longer present (ext removed, Jira disabled) are dropped,
 * - ids in `available` not yet in `saved` (new tabs) are appended in available order.
 *
 * Pure — no side effects, no runtime deps. Generic over any tab shape with an id
 * so it stays decoupled from icon/label definitions (and unit-testable in isolation).
 */
export function resolveTabOrder<T extends { id: SidebarActiveTab }>(
  available: T[],
  saved: readonly SidebarActiveTab[] | undefined,
): T[] {
  if (!saved || saved.length === 0) return [...available];

  const byId = new Map(available.map((t) => [t.id, t]));
  const ordered: T[] = [];
  const seen = new Set<SidebarActiveTab>();

  for (const id of saved) {
    const tab = byId.get(id);
    if (tab && !seen.has(id)) {
      ordered.push(tab);
      seen.add(id);
    }
  }
  for (const tab of available) {
    if (!seen.has(tab.id)) ordered.push(tab);
  }
  return ordered;
}
