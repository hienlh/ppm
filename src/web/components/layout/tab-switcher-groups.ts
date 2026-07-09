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
  label: string;
  tabs: Tab[];
}

/**
 * @param tabs        merged, project-filtered tabs (as MobileNav already computes)
 * @param tabPanelMap tabId → panelId
 * @param panelOrder  panel ids in grid order (grid.flat())
 * @param query       filter text (matches tab title + type, case-insensitive)
 */
export function buildTabSwitcherGroups(
  tabs: Tab[],
  tabPanelMap: Record<string, string>,
  panelOrder: string[],
  query: string,
): { groups: TabSwitcherGroup[]; total: number } {
  const q = query.trim().toLowerCase();
  const matches = (t: Tab) =>
    !q || t.title.toLowerCase().includes(q) || t.type.toLowerCase().includes(q);

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
