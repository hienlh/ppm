import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { PPMBotSessionManager } from "../../../../src/services/ppmbot/ppmbot-session.ts";

describe("PPMBot SessionManager", () => {
  let manager: PPMBotSessionManager;

  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
    manager = new PPMBotSessionManager();
  });

  describe("resolveProject", () => {
    it("should resolve exact project name (case-insensitive)", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: [
          { name: "MyApp", path: "/projects/myapp" },
          { name: "Backend", path: "/projects/backend" },
        ],
      };

      const result = manager.resolveProject("myapp");
      expect(result).toBeTruthy();
      expect(result!.name).toBe("MyApp");
      expect(result!.path).toBe("/projects/myapp");
    });

    it("should resolve prefix match when unique", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: [
          { name: "MyApp", path: "/projects/myapp" },
          { name: "Backend", path: "/projects/backend" },
        ],
      };

      const result = manager.resolveProject("back");
      expect(result).toBeTruthy();
      expect(result!.name).toBe("Backend");
    });

    it("should return null for ambiguous prefix", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: [
          { name: "MyApp1", path: "/projects/myapp1" },
          { name: "MyApp2", path: "/projects/myapp2" },
        ],
      };

      const result = manager.resolveProject("myapp");
      expect(result).toBeNull();
    });

    it("should return null when no projects configured", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: [],
      };

      const result = manager.resolveProject("anything");
      expect(result).toBeNull();
    });
  });

  describe("getProjectNames", () => {
    it("should return all project names", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: [
          { name: "Alpha", path: "/a" },
          { name: "Beta", path: "/b" },
        ],
      };

      const names = manager.getProjectNames();
      expect(names).toEqual(["Alpha", "Beta"]);
    });

    it("should return empty array when no projects", () => {
      (configService as any).config = {
        ...(configService as any).config,
        projects: undefined,
      };

      const names = manager.getProjectNames();
      expect(names).toEqual([]);
    });
  });
});
