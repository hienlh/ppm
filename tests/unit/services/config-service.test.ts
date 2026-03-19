import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  openTestDb,
  setDb,
  closeDb,
  getConfigValue,
  getAllConfig,
  getProjects,
} from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

describe("ConfigService (SQLite-backed)", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  afterEach(() => {
    // Restore auth disabled for other test files, re-init test DB
    (configService as any).config.auth = { enabled: false, token: "" };
    const testDb = openTestDb();
    setDb(testDb);
  });

  describe("load()", () => {
    it("creates default config in empty DB", () => {
      const config = configService.load();
      expect(config.port).toBe(8080);
      expect(config.host).toBe("0.0.0.0");
      expect(config.theme).toBe("system");
      expect(config.auth.enabled).toBe(true);
      expect(config.auth.token).toBeTruthy(); // auto-generated
      expect(config.projects).toEqual([]);
    });

    it("reads existing config from DB", () => {
      // Pre-populate DB
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("port", JSON.stringify(9999));
      setConfigValue("device_name", JSON.stringify("test-machine"));
      setConfigValue("theme", JSON.stringify("dark"));

      const config = configService.load();
      expect(config.port).toBe(9999);
      expect(config.device_name).toBe("test-machine");
      expect(config.theme).toBe("dark");
    });

    it("auto-generates auth token if enabled but empty", () => {
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("auth", JSON.stringify({ enabled: true, token: "" }));

      const config = configService.load();
      expect(config.auth.enabled).toBe(true);
      expect(config.auth.token.length).toBeGreaterThan(0);
    });

    it("sanitizes invalid theme to default", () => {
      const { setConfigValue } = require("../../../src/services/db.service.ts");
      setConfigValue("theme", JSON.stringify("invalid-theme"));

      const config = configService.load();
      expect(config.theme).toBe("system");
    });
  });

  describe("get() / set()", () => {
    beforeEach(() => {
      configService.load();
    });

    it("get/set scalar config keys", () => {
      configService.set("port", 3000);
      expect(configService.get("port")).toBe(3000);
      // Verify persisted to DB
      expect(JSON.parse(getConfigValue("port")!)).toBe(3000);
    });

    it("get/set theme", () => {
      configService.set("theme", "dark");
      expect(configService.get("theme")).toBe("dark");
      expect(JSON.parse(getConfigValue("theme")!)).toBe("dark");
    });

    it("get/set auth object", () => {
      configService.set("auth", { enabled: false, token: "abc" });
      expect(configService.get("auth")).toEqual({ enabled: false, token: "abc" });
    });

    it("get/set ai config", () => {
      const ai = configService.get("ai");
      ai.default_provider = "claude";
      configService.set("ai", ai);
      expect(configService.get("ai").default_provider).toBe("claude");
    });
  });

  describe("projects via separate table", () => {
    beforeEach(() => {
      configService.load();
    });

    it("set('projects', ...) syncs to projects table", () => {
      const projects: ProjectConfig[] = [
        { path: "/home/user/proj1", name: "proj1" },
        { path: "/home/user/proj2", name: "proj2", color: "#ff0000" },
      ];
      configService.set("projects", projects);

      const dbProjects = getProjects();
      expect(dbProjects).toHaveLength(2);
      expect(dbProjects[0]!.name).toBe("proj1");
      expect(dbProjects[0]!.sort_order).toBe(0);
      expect(dbProjects[1]!.name).toBe("proj2");
      expect(dbProjects[1]!.color).toBe("#ff0000");
      expect(dbProjects[1]!.sort_order).toBe(1);
    });

    it("get('projects') returns from projects table", () => {
      configService.set("projects", [
        { path: "/a", name: "alpha" },
        { path: "/b", name: "beta", color: "#00ff00" },
      ]);

      const projects = configService.get("projects");
      expect(projects).toHaveLength(2);
      expect(projects[0]!.name).toBe("alpha");
      expect(projects[1]!.color).toBe("#00ff00");
    });

    it("reorder projects via set()", () => {
      configService.set("projects", [
        { path: "/a", name: "aaa" },
        { path: "/b", name: "bbb" },
        { path: "/c", name: "ccc" },
      ]);

      // Reorder: ccc, aaa, bbb
      configService.set("projects", [
        { path: "/c", name: "ccc" },
        { path: "/a", name: "aaa" },
        { path: "/b", name: "bbb" },
      ]);

      const dbProjects = getProjects();
      expect(dbProjects[0]!.name).toBe("ccc");
      expect(dbProjects[0]!.sort_order).toBe(0);
      expect(dbProjects[1]!.name).toBe("aaa");
      expect(dbProjects[2]!.name).toBe("bbb");
    });

    it("set projects with color then remove color", () => {
      configService.set("projects", [
        { path: "/a", name: "alpha", color: "#ff0000" },
      ]);
      // Update without color
      configService.set("projects", [
        { path: "/a", name: "alpha" },
      ]);
      const projects = configService.get("projects");
      expect(projects[0]!).not.toHaveProperty("color");
    });

    it("empty projects clears the table", () => {
      configService.set("projects", [{ path: "/a", name: "alpha" }]);
      configService.set("projects", []);
      expect(getProjects()).toHaveLength(0);
      expect(configService.get("projects")).toEqual([]);
    });
  });

  describe("save()", () => {
    it("persists all config keys to DB", () => {
      configService.load();
      configService.set("port", 4444);
      configService.set("device_name", "saved-machine");
      configService.save();

      // Verify directly from DB
      expect(JSON.parse(getConfigValue("port")!)).toBe(4444);
      expect(JSON.parse(getConfigValue("device_name")!)).toBe("saved-machine");
    });

    it("save() also syncs projects", () => {
      configService.load();
      // Modify in-memory projects
      const config = configService.getAll();
      config.projects = [{ path: "/x", name: "x-project" }];
      configService.save();

      const dbProjects = getProjects();
      expect(dbProjects).toHaveLength(1);
      expect(dbProjects[0]!.name).toBe("x-project");
    });
  });

  describe("getAll()", () => {
    it("returns full PpmConfig including projects", () => {
      configService.load();
      configService.set("projects", [{ path: "/p", name: "my-proj" }]);

      const all = configService.getAll();
      expect(all.port).toBeDefined();
      expect(all.auth).toBeDefined();
      expect(all.projects).toHaveLength(1);
      expect(all.projects[0]!.name).toBe("my-proj");
    });
  });

  describe("getConfigPath()", () => {
    it("returns a .db file path", () => {
      const path = configService.getConfigPath();
      expect(path).toContain("ppm");
      expect(path).toContain(".db");
    });
  });
});
