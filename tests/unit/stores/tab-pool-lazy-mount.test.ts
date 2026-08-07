/**
 * Tests for lazy tab mounting (filterMountableEntries).
 *
 * Locks the boot-cost contract: a saved workspace with many tabs must mount only
 * what is visible, and a tab must stay mounted once it has been visible so
 * TabPool's keep-alive (xterm buffer, Monaco state, chat scroll) still holds.
 */
import { describe, it, expect } from "bun:test";
import { collectTabEntries, filterMountableEntries } from "../../../src/web/components/layout/tab-pool-collect";
import { DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

function makePanel(id: string, tabs: { id: string; type: string; projectId?: string }[], activeTabId?: string): Panel {
  const builtTabs = tabs.map((t) => ({
    id: t.id,
    type: t.type as Panel["tabs"][number]["type"],
    title: t.id,
    projectId: t.projectId ?? null,
    closable: true,
  }));
  return {
    id,
    tabs: builtTabs,
    activeTabId: activeTabId ?? builtTabs[0]?.id ?? null,
    tabHistory: builtTabs.map((t) => t.id),
  };
}

/** Panel holding 5 chat tabs with the 3rd active — mirrors a real saved workspace. */
function manyChatTabs(panelId: string, prefix: string, activeIndex: number): Panel {
  const tabs = [0, 1, 2, 3, 4].map((i) => ({ id: `${prefix}${i}`, type: "chat", projectId: "proj-1" }));
  return makePanel(panelId, tabs, tabs[activeIndex]!.id);
}

describe("filterMountableEntries — single panel", () => {
  it("mounts only the active tab out of 5 saved chat tabs", () => {
    const panels: Record<string, Panel> = { "panel-A": manyChatTabs("panel-A", "chat:a", 2) };
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");
    expect(entries).toHaveLength(5);

    const mountable = filterMountableEntries(entries, new Set());
    expect(mountable.map((e) => e.tabId)).toEqual(["chat:a2"]);
  });

  it("keeps a previously mounted tab even after it stops being active", () => {
    const panels: Record<string, Panel> = { "panel-A": manyChatTabs("panel-A", "chat:a", 0) };
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    // chat:a2 was visible earlier this session, chat:a0 is visible now.
    const mountable = filterMountableEntries(entries, new Set(["chat:a2"]));
    expect(mountable.map((e) => e.tabId).sort()).toEqual(["chat:a0", "chat:a2"]);
  });

  it("mounts nothing extra when the mounted set holds unknown ids", () => {
    const panels: Record<string, Panel> = { "panel-A": manyChatTabs("panel-A", "chat:a", 1) };
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const mountable = filterMountableEntries(entries, new Set(["chat:gone", "terminal:dead"]));
    expect(mountable.map((e) => e.tabId)).toEqual(["chat:a1"]);
  });
});

describe("filterMountableEntries — split panels", () => {
  it("mounts the active tab of EVERY panel in a 2x1 split, not just one", () => {
    const panels: Record<string, Panel> = {
      "panel-A": manyChatTabs("panel-A", "chat:a", 1),
      "panel-B": manyChatTabs("panel-B", "chat:b", 3),
    };
    const entries = collectTabEntries(panels, [["panel-A", "panel-B"]], {}, "proj-1");
    expect(entries).toHaveLength(10);

    const mountable = filterMountableEntries(entries, new Set());
    expect(mountable.map((e) => e.tabId).sort()).toEqual(["chat:a1", "chat:b3"]);
  });

  it("mounts the active tab of every panel across a 2-row grid", () => {
    const panels: Record<string, Panel> = {
      "panel-A": manyChatTabs("panel-A", "chat:a", 0),
      "panel-B": manyChatTabs("panel-B", "chat:b", 1),
      "panel-C": manyChatTabs("panel-C", "chat:c", 2),
    };
    const entries = collectTabEntries(panels, [["panel-A", "panel-B"], ["panel-C"]], {}, "proj-1");

    const mountable = filterMountableEntries(entries, new Set());
    expect(mountable.map((e) => e.tabId).sort()).toEqual(["chat:a0", "chat:b1", "chat:c2"]);
  });
});

describe("filterMountableEntries — dock", () => {
  it("mounts the dock's active tab alongside the grid's active tab", () => {
    const panels: Record<string, Panel> = {
      "panel-A": manyChatTabs("panel-A", "chat:a", 0),
      [DOCK_PANEL_ID]: makePanel(
        DOCK_PANEL_ID,
        [
          { id: "terminal:1", type: "terminal", projectId: "proj-1" },
          { id: "terminal:2", type: "terminal", projectId: "proj-1" },
        ],
        "terminal:2",
      ),
    };
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const mountable = filterMountableEntries(entries, new Set());
    expect(mountable.map((e) => e.tabId).sort()).toEqual(["chat:a0", "terminal:2"]);
  });
});

describe("filterMountableEntries — keep-alive across projects", () => {
  it("mounts the active tab of a non-active project's snapshotted grid", () => {
    const panels: Record<string, Panel> = {
      "panel-A": manyChatTabs("panel-A", "chat:a", 0),
      // Built explicitly (not via manyChatTabs) so the tabs carry projectId proj-2.
      "panel-Z": makePanel(
        "panel-Z",
        [
          { id: "chat:z0", type: "chat", projectId: "proj-2" },
          { id: "chat:z1", type: "chat", projectId: "proj-2" },
        ],
        "chat:z1",
      ),
    };

    const entries = collectTabEntries(panels, [["panel-A"]], { "proj-2": [["panel-Z"]] }, "proj-1");

    const mountable = filterMountableEntries(entries, new Set());
    expect(mountable.map((e) => e.tabId).sort()).toEqual(["chat:a0", "chat:z1"]);
  });
});

describe("filterMountableEntries — ordering", () => {
  it("preserves the stable tabId sort from collectTabEntries", () => {
    const panels: Record<string, Panel> = { "panel-A": manyChatTabs("panel-A", "chat:a", 0) };
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const mounted = new Set(["chat:a4", "chat:a2"]);
    const mountable = filterMountableEntries(entries, mounted);

    const ids = mountable.map((e) => e.tabId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});
