/**
 * Pure grouping/filtering for the mobile tab-switcher sheet (handoff A2).
 *
 * Groups tabs by their split panel (matching the web split layout), orders groups
 * by grid order, labels them "Panel N", applies a case-insensitive title/type
 * filter, and drops groups with zero matches. DOM-free for unit testing.
 */
import type { Tab } from "@/stores/tab-store";

export interface TabSwitcherGroup {
  panelId: string;
  /** Empty string → the sheet renders the group without a panel header (recent mode). */
  label: string;
  tabs: Tab[];
}

export type TabSortMode = "default" | "recent";

/**
 * @param tabs        merged, project-filtered tabs (as MobileNav already computes)
 * @param tabPanelMap tabId → panelId
 * @param panelOrder  panel ids in grid order (grid.flat())
 * @param query       filter text (matches tab title + type, case-insensitive)
 * @param opts.sortMode "default" groups by split panel; "recent" is a flat list
 *                      ordered most-recently-active first
 * @param opts.recency  tabId → rank (0 = most recent); used only in "recent" mode
 */
export function buildTabSwitcherGroups(
  tabs: Tab[],
  tabPanelMap: Record<string, string>,
  panelOrder: string[],
  query: string,
  opts?: { sortMode?: TabSortMode; recency?: Map<string, number> },
): { groups: TabSwitcherGroup[]; total: number } {
  const q = query.trim().toLowerCase();
  const matches = (t: Tab) =>
    !q || t.title.toLowerCase().includes(q) || t.type.toLowerCase().includes(q);

  // Recent mode: single flat, header-less group sorted by recency. Array.sort is
  // stable, so tabs with no recency rank keep their original (insertion) order.
  if (opts?.sortMode === "recent") {
    const recency = opts.recency;
    const rank = (t: Tab) => recency?.get(t.id) ?? Number.MAX_SAFE_INTEGER;
    const flat = tabs.filter(matches).sort((a, b) => rank(a) - rank(b));
    return {
      groups: flat.length ? [{ panelId: "__recent__", label: "", tabs: flat }] : [],
      total: flat.length,
    };
  }

  const byPanel = new Map<string, Tab[]>();
  for (const t of tabs) {
    if (!matches(t)) continue;
    const pid = tabPanelMap[t.id] ?? panelOrder[0] ?? "__unknown__";
    (byPanel.get(pid) ?? byPanel.set(pid, []).get(pid)!).push(t);
  }

  // Order groups by grid order; index in panelOrder drives the "Panel N" label
  // so labels stay stable even when a group is empty and hidden.
  const groups: TabSwitcherGroup[] = [];
  const ordered = panelOrder.length > 0 ? panelOrder : [...byPanel.keys()];
  ordered.forEach((pid, i) => {
    const groupTabs = byPanel.get(pid);
    if (!groupTabs || groupTabs.length === 0) return; // hide empty groups
    groups.push({ panelId: pid, label: `Panel ${i + 1}`, tabs: groupTabs });
  });

  const total = groups.reduce((n, g) => n + g.tabs.length, 0);
  return { groups, total };
}
