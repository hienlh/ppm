import { describe, it, expect } from "bun:test";
import { migratePortsToTunnels, type PanelLayout } from "../../../src/web/stores/panel-utils.ts";
import type { Tab } from "../../../src/web/stores/tab-store.ts";

const tab = (id: string, type: string): Tab =>
  ({ id, type: type as Tab["type"], title: id, projectId: null, closable: true });

function makeLayout(over: Partial<PanelLayout> = {}): PanelLayout {
  return {
    panels: {
      p1: { id: "p1", tabs: [tab("terminal:1", "terminal"), tab("ports", "ports")], activeTabId: "ports", tabHistory: ["terminal:1", "ports"] },
    },
    grid: [["p1"]],
    focusedPanelId: "p1",
    ...over,
  };
}

describe("migratePortsToTunnels", () => {
  it("removes a legacy ports tab from a grid panel", () => {
    const out = migratePortsToTunnels(makeLayout());
    const p1 = out.panels.p1!;
    expect(p1.tabs.map((t) => t.type)).not.toContain("ports");
    expect(p1.tabs).toHaveLength(1);
    expect(p1.tabs[0]!.type).toBe("terminal");
  });

  it("falls back activeTabId + tabHistory when the ports tab was active", () => {
    const out = migratePortsToTunnels(makeLayout());
    const p1 = out.panels.p1!;
    expect(p1.activeTabId).toBe("terminal:1");
    expect(p1.tabHistory).not.toContain("ports");
  });

  it("removes a legacy ports tab from the dock panel", () => {
    const layout = makeLayout({
      dockPanel: { id: "__dock__", tabs: [tab("terminal:1", "terminal"), tab("ports", "ports")], activeTabId: "ports", tabHistory: ["ports"] },
    });
    const out = migratePortsToTunnels(layout);
    expect(out.dockPanel!.tabs.map((t) => t.type)).not.toContain("ports");
    expect(out.dockPanel!.activeTabId).toBe("terminal:1");
  });

  it("is idempotent on a blob with no legacy tab types", () => {
    const clean = makeLayout({
      panels: { p1: { id: "p1", tabs: [tab("terminal:1", "terminal")], activeTabId: "terminal:1", tabHistory: ["terminal:1"] } },
    });
    const out = migratePortsToTunnels(clean);
    expect(out.panels.p1!.tabs).toHaveLength(1);
    expect(out.panels.p1!.tabs[0]!.type).toBe("terminal");
    expect(out.panels.p1!.activeTabId).toBe("terminal:1");
  });

  it("leaves a panel empty (no crash) when it held only a ports tab", () => {
    const layout = makeLayout({
      panels: { p1: { id: "p1", tabs: [tab("ports", "ports")], activeTabId: "ports", tabHistory: ["ports"] } },
    });
    const out = migratePortsToTunnels(layout);
    expect(out.panels.p1!.tabs).toHaveLength(0);
    expect(out.panels.p1!.activeTabId).toBeNull();
  });

  it("removes a legacy tunnels tab from a grid panel (0.17.8 dock→sidebar move)", () => {
    const layout = makeLayout({
      panels: { p1: { id: "p1", tabs: [tab("terminal:1", "terminal"), tab("tunnels", "tunnels")], activeTabId: "tunnels", tabHistory: ["terminal:1", "tunnels"] } },
    });
    const out = migratePortsToTunnels(layout);
    expect(out.panels.p1!.tabs.map((t) => t.type)).not.toContain("tunnels");
    expect(out.panels.p1!.activeTabId).toBe("terminal:1");
  });

  it("removes a legacy tunnels tab from the dock panel", () => {
    const layout = makeLayout({
      dockPanel: { id: "__dock__", tabs: [tab("terminal:1", "terminal"), tab("tunnels", "tunnels")], activeTabId: "tunnels", tabHistory: ["tunnels"] },
    });
    const out = migratePortsToTunnels(layout);
    expect(out.dockPanel!.tabs.map((t) => t.type)).not.toContain("tunnels");
    expect(out.dockPanel!.activeTabId).toBe("terminal:1");
  });

  it("strips both legacy ports and tunnels tabs together", () => {
    const layout = makeLayout({
      panels: { p1: { id: "p1", tabs: [tab("ports", "ports"), tab("tunnels", "tunnels"), tab("editor:x", "editor")], activeTabId: "tunnels", tabHistory: ["ports", "tunnels", "editor:x"] } },
    });
    const out = migratePortsToTunnels(layout);
    const types = out.panels.p1!.tabs.map((t) => t.type);
    expect(types).toEqual(["editor"]);
    expect(out.panels.p1!.activeTabId).toBe("editor:x");
  });
});
