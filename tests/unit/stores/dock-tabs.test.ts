/**
 * countDockTabs helper tests (Phase 4 status-bar toggle count / Phase 6 green dot).
 */
import { describe, it, expect } from "bun:test";
import { countDockTabs } from "../../../src/web/components/layout/dock-tabs";
import type { Panel } from "../../../src/web/stores/panel-utils";
import type { Tab } from "../../../src/web/stores/tab-store";

function tab(id: string, projectId: string | null): Tab {
  return { id, type: "terminal", title: id, projectId, closable: true, metadata: {} };
}

function dockPanel(tabs: Tab[]): Panel {
  return { id: "__dock__", tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: [] };
}

describe("countDockTabs", () => {
  it("returns 0 for undefined dock panel", () => {
    expect(countDockTabs(undefined, "proj")).toBe(0);
  });

  it("returns 0 for empty dock", () => {
    expect(countDockTabs(dockPanel([]), "proj")).toBe(0);
  });

  it("counts only the active project's tabs", () => {
    const dp = dockPanel([tab("t1", "proj"), tab("t2", "other"), tab("t3", "proj")]);
    expect(countDockTabs(dp, "proj")).toBe(2);
  });

  it("counts project-less tabs regardless of active project", () => {
    const dp = dockPanel([tab("t1", null), tab("t2", "proj")]);
    expect(countDockTabs(dp, "proj")).toBe(2);
  });

  it("counts all tabs when no active project", () => {
    const dp = dockPanel([tab("t1", "a"), tab("t2", "b")]);
    expect(countDockTabs(dp, null)).toBe(2);
  });
});
