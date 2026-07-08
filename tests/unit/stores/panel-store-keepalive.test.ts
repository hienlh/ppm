/**
 * Characterization tests for the tab-collection contract used by TabPool.
 *
 * These lock CURRENT behavior on main before phase 03 extends it with dock
 * support. The pure helper `collectTabEntries` was extracted from tab-pool.tsx
 * into tab-pool-collect.ts so it is testable without a DOM.
 *
 * Key behaviors locked here:
 * - A terminal tab in a grid panel produces exactly one TabEntry.
 * - Duplicate tabIds across projectGrids are deduped (each tabId appears once).
 * - extension/extension-webview tabs from a non-active project are SKIPPED
 *   (cross-project server recovery guard — tab-pool.tsx original line 114).
 * - Non-extension tabs from non-active projects ARE kept (full keep-alive).
 */
import { describe, it, expect } from "bun:test";
import { collectTabEntries } from "../../../src/web/components/layout/tab-pool-collect";
import type { Panel } from "../../../src/web/stores/panel-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(id: string, tabs: { id: string; type: string; projectId?: string }[]): Panel {
  return {
    id,
    tabs: tabs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: t.projectId ?? null,
      closable: true,
    })),
    activeTabId: tabs[0]?.id ?? null,
    tabHistory: tabs.map((t) => t.id),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("collectTabEntries — characterization", () => {
  it("yields one entry for a terminal tab in a single grid panel", () => {
    const panel = makePanel("panel-A", [{ id: "terminal:1", type: "terminal", projectId: "proj-1" }]);
    const panels: Record<string, Panel> = { "panel-A": panel };
    const grid = [["panel-A"]];
    const projectGrids: Record<string, string[][]> = {};

    const entries = collectTabEntries(panels, grid, projectGrids, "proj-1");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe("terminal:1");
    expect(entries[0]?.panelId).toBe("panel-A");
    expect(entries[0]?.type).toBe("terminal");
  });

  it("marks the active tab's isActive as true", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal", projectId: "proj-1" },
      { id: "editor:/foo.ts", type: "editor", projectId: "proj-1" },
    ]);
    // activeTabId defaults to first tab — terminal:1
    const panels: Record<string, Panel> = { "panel-A": panel };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const termEntry = entries.find((e) => e.tabId === "terminal:1");
    const editorEntry = entries.find((e) => e.tabId === "editor:/foo.ts");
    expect(termEntry?.isActive).toBe(true);
    expect(editorEntry?.isActive).toBe(false);
  });

  it("deduplicates tabIds when the same tabId appears across projectGrids", () => {
    // Simulates a race where a tab got added to two project snapshots
    const panel1 = makePanel("panel-A", [{ id: "terminal:1", type: "terminal", projectId: "proj-1" }]);
    const panel2 = makePanel("panel-B", [{ id: "terminal:1", type: "terminal", projectId: "proj-2" }]);
    const panels: Record<string, Panel> = {
      "panel-A": panel1,
      "panel-B": panel2,
    };
    const grid = [["panel-A"]];
    const projectGrids: Record<string, string[][]> = { "proj-2": [["panel-B"]] };

    const entries = collectTabEntries(panels, grid, projectGrids, "proj-1");

    const ids = entries.map((e) => e.tabId);
    // Only one entry per tabId — dedup wins
    expect(ids.filter((id) => id === "terminal:1")).toHaveLength(1);
  });

  it("skips extension tabs from a non-active project (cross-project recovery guard)", () => {
    const activePanel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal", projectId: "active-proj" },
    ]);
    const inactivePanel = makePanel("panel-B", [
      { id: "extension:my-ext", type: "extension", projectId: "other-proj" },
    ]);
    const panels: Record<string, Panel> = {
      "panel-A": activePanel,
      "panel-B": inactivePanel,
    };
    const grid = [["panel-A"]];
    const projectGrids: Record<string, string[][]> = { "other-proj": [["panel-B"]] };

    const entries = collectTabEntries(panels, grid, projectGrids, "active-proj");

    // extension tab from inactive project must be absent
    expect(entries.find((e) => e.tabId === "extension:my-ext")).toBeUndefined();
    // active project's terminal still present
    expect(entries.find((e) => e.tabId === "terminal:1")).toBeDefined();
  });

  it("keeps non-extension tabs from non-active projects (keep-alive contract)", () => {
    const activePanel = makePanel("panel-A", [
      { id: "editor:/a.ts", type: "editor", projectId: "proj-1" },
    ]);
    const inactivePanel = makePanel("panel-B", [
      { id: "terminal:2", type: "terminal", projectId: "proj-2" },
    ]);
    const panels: Record<string, Panel> = {
      "panel-A": activePanel,
      "panel-B": inactivePanel,
    };
    const grid = [["panel-A"]];
    const projectGrids: Record<string, string[][]> = { "proj-2": [["panel-B"]] };

    const entries = collectTabEntries(panels, grid, projectGrids, "proj-1");

    // terminal:2 from inactive project IS included (keep-alive — only extensions are excluded)
    expect(entries.find((e) => e.tabId === "terminal:2")).toBeDefined();
  });

  it("returns entries sorted by tabId (stable order for React reconciliation)", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:2", type: "terminal", projectId: "proj-1" },
      { id: "chat:default/abc", type: "chat", projectId: "proj-1" },
      { id: "editor:/z.ts", type: "editor", projectId: "proj-1" },
    ]);
    const panels: Record<string, Panel> = { "panel-A": panel };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const ids = entries.map((e) => e.tabId);
    expect(ids).toEqual([...ids].sort());
  });
});
