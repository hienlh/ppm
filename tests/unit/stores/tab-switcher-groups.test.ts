/**
 * buildTabSwitcherGroups tests (Phase 7 mobile tab switcher).
 * Groups by split panel, orders by grid, labels "Panel N", filters, hides empty groups.
 */
import { describe, it, expect } from "bun:test";
import { buildTabSwitcherGroups } from "../../../src/web/components/layout/tab-switcher-groups";
import type { Tab } from "../../../src/web/stores/tab-store";

function tab(id: string, title: string, type: Tab["type"] = "chat"): Tab {
  return { id, type, title, projectId: "proj", closable: true, metadata: {} };
}

describe("buildTabSwitcherGroups", () => {
  const tabs = [tab("a", "Alpha"), tab("b", "Beta", "terminal"), tab("c", "Gamma")];
  const map = { a: "p1", b: "p1", c: "p2" };
  const order = ["p1", "p2"];

  it("groups tabs by panel, labels Panel N in grid order", () => {
    const { groups, total } = buildTabSwitcherGroups(tabs, map, order, "");
    expect(groups.map((g) => g.label)).toEqual(["Panel 1", "Panel 2"]);
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups[1]!.tabs.map((t) => t.id)).toEqual(["c"]);
    expect(total).toBe(3);
  });

  it("filters by title (case-insensitive) and hides empty groups", () => {
    const { groups, total } = buildTabSwitcherGroups(tabs, map, order, "gam");
    expect(groups.map((g) => g.label)).toEqual(["Panel 2"]);
    expect(total).toBe(1);
  });

  it("filters by tab type", () => {
    const { groups } = buildTabSwitcherGroups(tabs, map, order, "terminal");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tabs[0]!.id).toBe("b");
  });

  it("returns no groups when nothing matches", () => {
    const { groups, total } = buildTabSwitcherGroups(tabs, map, order, "zzz");
    expect(groups).toEqual([]);
    expect(total).toBe(0);
  });

  it("label index follows grid order even when an earlier panel is empty after filter", () => {
    // Filter to only p2's tab → its label must still be 'Panel 2' (grid index 1)
    const { groups } = buildTabSwitcherGroups(tabs, map, order, "gamma");
    expect(groups[0]!.label).toBe("Panel 2");
  });

  describe("recent sort mode", () => {
    const recency = new Map([["c", 0], ["a", 1], ["b", 2]]);

    it("returns one flat, header-less group ordered by recency (0 = most recent)", () => {
      const { groups, total } = buildTabSwitcherGroups(tabs, map, order, "", { sortMode: "recent", recency });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.label).toBe("");
      expect(groups[0]!.tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
      expect(total).toBe(3);
    });

    it("tabs missing a recency rank sink to the end, keeping insertion order", () => {
      const partial = new Map([["b", 0]]);
      const { groups } = buildTabSwitcherGroups(tabs, map, order, "", { sortMode: "recent", recency: partial });
      expect(groups[0]!.tabs.map((t) => t.id)).toEqual(["b", "a", "c"]);
    });

    it("still applies the query filter in recent mode", () => {
      const { groups, total } = buildTabSwitcherGroups(tabs, map, order, "gam", { sortMode: "recent", recency });
      expect(total).toBe(1);
      expect(groups[0]!.tabs[0]!.id).toBe("c");
    });
  });
});
