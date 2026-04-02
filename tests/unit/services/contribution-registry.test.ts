import { describe, it, expect, beforeEach } from "bun:test";
import { contributionRegistry } from "../../../src/services/contribution-registry.ts";
import type { ExtensionContributes } from "../../../src/types/extension.ts";

describe("ContributionRegistry", () => {
  beforeEach(() => {
    contributionRegistry.clear();
  });

  describe("register", () => {
    it("registers commands from extension", () => {
      const contributes: ExtensionContributes = {
        commands: [
          { command: "ext.cmd1", title: "Command 1" },
          { command: "ext.cmd2", title: "Command 2", category: "Extension" },
        ],
      };

      contributionRegistry.register("ext-id", contributes);
      const commands = contributionRegistry.getCommands();

      expect(commands.length).toBe(2);
      expect(commands.find((c) => c.command === "ext.cmd1")).toBeTruthy();
      expect(commands.find((c) => c.command === "ext.cmd2")?.category).toBe("Extension");
    });

    it("adds extId to registered commands", () => {
      const contributes: ExtensionContributes = {
        commands: [{ command: "test.cmd", title: "Test" }],
      };

      contributionRegistry.register("my-ext", contributes);
      const commands = contributionRegistry.getCommands();

      expect(commands[0].extId).toBe("my-ext");
    });

    it("registers views in locations", () => {
      const contributes: ExtensionContributes = {
        views: {
          "sidebar": [{ id: "view1", name: "View 1" }],
          "panel": [{ id: "view2", name: "View 2" }],
        },
      };

      contributionRegistry.register("ext-views", contributes);

      const sidebarViews = contributionRegistry.getViews("sidebar");
      const panelViews = contributionRegistry.getViews("panel");

      expect(sidebarViews.length).toBe(1);
      expect(sidebarViews[0].id).toBe("view1");
      expect(sidebarViews[0].extId).toBe("ext-views");

      expect(panelViews.length).toBe(1);
      expect(panelViews[0].id).toBe("view2");
    });

    it("registers configuration properties", () => {
      const contributes: ExtensionContributes = {
        configuration: {
          properties: {
            "ext.setting1": { type: "string", default: "value" },
            "ext.setting2": { type: "number", default: 42 },
          },
        },
      };

      contributionRegistry.register("ext-config", contributes);
      const config = contributionRegistry.getConfiguration("ext-config");

      expect(config["ext-config"]).toEqual({
        "ext.setting1": { type: "string", default: "value" },
        "ext.setting2": { type: "number", default: 42 },
      });
    });

    it("handles empty contributes", () => {
      contributionRegistry.register("empty-ext", {});

      expect(contributionRegistry.getCommands().length).toBe(0);
      expect(contributionRegistry.getViews().length).toBe(0);
      expect(Object.keys(contributionRegistry.getConfiguration()).length).toBe(0);
    });

    it("allows multiple extensions to contribute", () => {
      contributionRegistry.register("ext1", {
        commands: [{ command: "ext1.cmd", title: "Ext1 Command" }],
      });
      contributionRegistry.register("ext2", {
        commands: [{ command: "ext2.cmd", title: "Ext2 Command" }],
      });

      const commands = contributionRegistry.getCommands();
      expect(commands.length).toBe(2);
      expect(commands.find((c) => c.extId === "ext1")).toBeTruthy();
      expect(commands.find((c) => c.extId === "ext2")).toBeTruthy();
    });
  });

  describe("unregister", () => {
    it("removes commands belonging to extension", () => {
      contributionRegistry.register("ext1", {
        commands: [{ command: "ext1.cmd", title: "Command" }],
      });
      contributionRegistry.register("ext2", {
        commands: [{ command: "ext2.cmd", title: "Command" }],
      });

      contributionRegistry.unregister("ext1");

      const commands = contributionRegistry.getCommands();
      expect(commands.length).toBe(1);
      expect(commands[0].extId).toBe("ext2");
    });

    it("removes views belonging to extension", () => {
      contributionRegistry.register("ext1", {
        views: { sidebar: [{ id: "view1", name: "View 1" }] },
      });
      contributionRegistry.register("ext2", {
        views: { sidebar: [{ id: "view2", name: "View 2" }] },
      });

      contributionRegistry.unregister("ext1");

      const views = contributionRegistry.getViews("sidebar");
      expect(views.length).toBe(1);
      expect(views[0].extId).toBe("ext2");
    });

    it("removes configuration for extension", () => {
      contributionRegistry.register("ext1", {
        configuration: { properties: { "ext1.setting": { type: "string" } } },
      });
      contributionRegistry.register("ext2", {
        configuration: { properties: { "ext2.setting": { type: "string" } } },
      });

      contributionRegistry.unregister("ext1");

      const config = contributionRegistry.getConfiguration();
      expect(Object.keys(config)).toEqual(["ext2"]);
    });

    it("unregister non-existent extension is safe", () => {
      contributionRegistry.register("ext1", {
        commands: [{ command: "ext1.cmd", title: "Command" }],
      });

      // Should not throw
      contributionRegistry.unregister("non-existent");

      expect(contributionRegistry.getCommands().length).toBe(1);
    });
  });

  describe("getCommands", () => {
    it("returns all commands from all extensions", () => {
      contributionRegistry.register("ext1", {
        commands: [
          { command: "ext1.cmd1", title: "Cmd 1" },
          { command: "ext1.cmd2", title: "Cmd 2" },
        ],
      });
      contributionRegistry.register("ext2", {
        commands: [{ command: "ext2.cmd1", title: "Cmd 1" }],
      });

      const commands = contributionRegistry.getCommands();
      expect(commands.length).toBe(3);
    });

    it("returns empty array if no commands", () => {
      expect(contributionRegistry.getCommands()).toEqual([]);
    });
  });

  describe("getViews", () => {
    it("returns views for specific location", () => {
      contributionRegistry.register("ext1", {
        views: {
          sidebar: [
            { id: "sidebar-view1", name: "View 1" },
            { id: "sidebar-view2", name: "View 2" },
          ],
          panel: [{ id: "panel-view1", name: "Panel View" }],
        },
      });

      const sidebarViews = contributionRegistry.getViews("sidebar");
      expect(sidebarViews.length).toBe(2);
      expect(sidebarViews.every((v) => ["sidebar-view1", "sidebar-view2"].includes(v.id))).toBe(true);
    });

    it("returns all views if no location specified", () => {
      contributionRegistry.register("ext1", {
        views: {
          sidebar: [{ id: "view1", name: "View 1" }],
          panel: [{ id: "view2", name: "View 2" }],
        },
      });

      const allViews = contributionRegistry.getViews();
      expect(allViews.length).toBe(2);
    });

    it("returns empty array for non-existent location", () => {
      contributionRegistry.register("ext1", {
        views: { sidebar: [{ id: "view1", name: "View 1" }] },
      });

      expect(contributionRegistry.getViews("non-existent")).toEqual([]);
    });
  });

  describe("getViewLocations", () => {
    it("returns all locations with registered views", () => {
      contributionRegistry.register("ext1", {
        views: {
          sidebar: [{ id: "view1", name: "View 1" }],
          panel: [{ id: "view2", name: "View 2" }],
        },
      });
      contributionRegistry.register("ext2", {
        views: {
          toolbar: [{ id: "view3", name: "View 3" }],
        },
      });

      const locations = contributionRegistry.getViewLocations();
      expect(locations.sort()).toEqual(["panel", "sidebar", "toolbar"]);
    });

    it("returns empty array if no views", () => {
      expect(contributionRegistry.getViewLocations()).toEqual([]);
    });
  });

  describe("getConfiguration", () => {
    it("returns all configuration if no extId specified", () => {
      contributionRegistry.register("ext1", {
        configuration: { properties: { "ext1.setting": { type: "string" } } },
      });
      contributionRegistry.register("ext2", {
        configuration: { properties: { "ext2.setting": { type: "number" } } },
      });

      const config = contributionRegistry.getConfiguration();
      expect(Object.keys(config).length).toBe(2);
      expect(config["ext1"]).toBeTruthy();
      expect(config["ext2"]).toBeTruthy();
    });

    it("returns configuration for specific extension", () => {
      contributionRegistry.register("ext1", {
        configuration: { properties: { "ext1.setting": { type: "string" } } },
      });
      contributionRegistry.register("ext2", {
        configuration: { properties: { "ext2.setting": { type: "number" } } },
      });

      const config = contributionRegistry.getConfiguration("ext1");
      expect(Object.keys(config)).toEqual(["ext1"]);
      expect(config["ext1"]["ext1.setting"]).toBeTruthy();
    });

    it("returns empty object for extension with no config", () => {
      contributionRegistry.register("ext1", {});

      const config = contributionRegistry.getConfiguration("ext1");
      expect(config).toEqual({});
    });
  });

  describe("getAll", () => {
    it("returns all contributions indexed by location", () => {
      contributionRegistry.register("ext1", {
        commands: [{ command: "ext1.cmd", title: "Command" }],
        views: {
          sidebar: [{ id: "view1", name: "View 1" }],
          panel: [{ id: "view2", name: "View 2" }],
        },
        configuration: { properties: { "ext1.setting": { type: "string" } } },
      });

      const all = contributionRegistry.getAll();

      expect(all.commands.length).toBe(1);
      expect(all.views.sidebar.length).toBe(1);
      expect(all.views.panel.length).toBe(1);
      expect(all.configuration["ext1"]).toBeTruthy();
    });

    it("includes views from all locations", () => {
      contributionRegistry.register("ext1", {
        views: { sidebar: [{ id: "view1", name: "V1" }] },
      });
      contributionRegistry.register("ext2", {
        views: { panel: [{ id: "view2", name: "V2" }] },
      });

      const all = contributionRegistry.getAll();
      expect(Object.keys(all.views)).toEqual(["sidebar", "panel"]);
    });
  });

  describe("clear", () => {
    it("removes all contributions", () => {
      contributionRegistry.register("ext1", {
        commands: [{ command: "ext1.cmd", title: "Command" }],
        views: { sidebar: [{ id: "view1", name: "View" }] },
      });

      contributionRegistry.clear();

      expect(contributionRegistry.getCommands()).toEqual([]);
      expect(contributionRegistry.getViews()).toEqual([]);
      expect(Object.keys(contributionRegistry.getConfiguration())).toEqual([]);
    });
  });
});
