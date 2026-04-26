import { describe, it, expect } from "bun:test";
import { extensionService } from "../../../src/services/extension.service.ts";
import type { ExtensionManifest } from "../../../src/types/extension.ts";

describe("ExtensionService.parseManifest", () => {
  const service = extensionService;

  describe("valid manifests", () => {
    it("parses minimal manifest", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeTruthy();
      expect(manifest?.id).toBe("test-ext");
      expect(manifest?.version).toBe("1.0.0");
      expect(manifest?.main).toBe("index.js");
    });

    it("parses scoped package names", () => {
      const pkg = {
        name: "@ppm/ext-example",
        version: "1.0.0",
        main: "dist/index.js",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.id).toBe("@ppm/ext-example");
    });

    it("uses ppm.displayName over package displayName", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        displayName: "Package Display",
        ppm: { displayName: "PPM Display" },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.displayName).toBe("PPM Display");
    });

    it("falls back to package displayName", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        displayName: "Package Display",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.displayName).toBe("Package Display");
    });

    it("falls back to name if no displayName", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.displayName).toBe("test-ext");
    });

    it("parses description", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        description: "Test extension description",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.description).toBe("Test extension description");
    });

    it("parses icon from ppm field", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        ppm: { icon: "icon.png" },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.icon).toBe("icon.png");
    });

    it("parses engines.ppm version constraint", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        engines: { ppm: ">=0.8.0" },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.engines?.ppm).toBe(">=0.8.0");
    });

    it("parses activationEvents", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        activationEvents: ["onCommand:test.cmd", "onView:test-view"],
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.activationEvents).toEqual([
        "onCommand:test.cmd",
        "onView:test-view",
      ]);
    });

    it("parses contributes section", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        contributes: {
          commands: [{ command: "test.cmd", title: "Test Command" }],
          views: {
            sidebar: [{ id: "test-view", name: "Test View" }],
          },
        },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.contributes?.commands).toHaveLength(1);
      expect(manifest?.contributes?.commands?.[0].command).toBe("test.cmd");
      expect(manifest?.contributes?.views?.sidebar).toHaveLength(1);
    });

    it("parses permissions", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        permissions: ["filesystem:read", "network"],
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.permissions).toEqual(["filesystem:read", "network"]);
    });

    it("parses full ppm field", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        ppm: {
          displayName: "Custom Name",
          icon: "custom-icon.svg",
          webviewDir: "webview",
        },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.ppm?.displayName).toBe("Custom Name");
      expect(manifest?.ppm?.icon).toBe("custom-icon.svg");
      expect(manifest?.ppm?.webviewDir).toBe("webview");
    });

    it("handles all optional fields together", () => {
      const pkg = {
        name: "@scope/full-ext",
        version: "2.3.4",
        main: "dist/index.js",
        displayName: "Full Extension",
        description: "A fully configured extension",
        engines: { ppm: ">=0.9.0" },
        activationEvents: ["onStart"],
        contributes: {
          commands: [{ command: "full.test", title: "Test", category: "Full" }],
          views: {
            sidebar: [{ id: "full-view", name: "Full View", type: "tree" }],
          },
          configuration: {
            properties: {
              "full.setting": { type: "boolean", default: true },
            },
          },
        },
        ppm: {
          displayName: "Full PPM",
          icon: "icon.svg",
          webviewDir: "webviews",
        },
        permissions: ["workspace:read"],
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeTruthy();
      expect(manifest?.id).toBe("@scope/full-ext");
      expect(manifest?.version).toBe("2.3.4");
      expect(manifest?.displayName).toBe("Full PPM");
      expect(manifest?.description).toBe("A fully configured extension");
      expect(manifest?.engines?.ppm).toBe(">=0.9.0");
      expect(manifest?.activationEvents).toContain("onStart");
      expect(manifest?.contributes?.commands).toHaveLength(1);
      expect(manifest?.contributes?.views?.sidebar).toHaveLength(1);
      expect(manifest?.ppm?.webviewDir).toBe("webviews");
      expect(manifest?.permissions).toContain("workspace:read");
    });
  });

  describe("invalid manifests", () => {
    it("returns null if name is missing", () => {
      const pkg = {
        version: "1.0.0",
        main: "index.js",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeNull();
    });

    it("returns null if version is missing", () => {
      const pkg = {
        name: "test-ext",
        main: "index.js",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeNull();
    });

    it("returns null if main is missing", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeNull();
    });

    it("returns null if multiple required fields are missing", () => {
      const pkg = {
        name: "test-ext",
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeNull();
    });

    it("returns null for empty object", () => {
      const manifest = service.parseManifest({});

      expect(manifest).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles undefined optional fields", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        description: undefined,
        icon: undefined,
        activationEvents: undefined,
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeTruthy();
      expect(manifest?.description).toBeUndefined();
      expect(manifest?.icon).toBeUndefined();
      expect(manifest?.activationEvents).toBeUndefined();
    });

    it("handles null optional fields", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        displayName: null,
        description: null,
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeTruthy();
      // displayName should fall back to name
      expect(manifest?.displayName).toBe("test-ext");
      expect(manifest?.description).toBeNull();
    });

    it("handles empty strings", () => {
      const pkg = {
        name: "",
        version: "1.0.0",
        main: "index.js",
      };

      // Empty name is still falsy, should return null
      const manifest = service.parseManifest(pkg);
      expect(manifest).toBeNull();
    });

    it("preserves manifest structure with extra fields", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        custom_field: "should be ignored",
        nested: { extra: "data" },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest).toBeTruthy();
      // Extra fields should not be in manifest
      expect((manifest as any)?.custom_field).toBeUndefined();
    });

    it("handles complex version strings", () => {
      const versions = ["1.0.0", "0.0.1-alpha.1", "2.0.0-rc1+build.123", "10.20.30"];

      for (const version of versions) {
        const pkg = {
          name: "test-ext",
          version,
          main: "index.js",
        };

        const manifest = service.parseManifest(pkg);
        expect(manifest?.version).toBe(version);
      }
    });

    it("handles complex main paths", () => {
      const mainPaths = ["index.js", "dist/index.js", "./src/main.ts", "lib/extensions/index.js"];

      for (const main of mainPaths) {
        const pkg = {
          name: "test-ext",
          version: "1.0.0",
          main,
        };

        const manifest = service.parseManifest(pkg);
        expect(manifest?.main).toBe(main);
      }
    });

    it("handles ppm field without displayName or icon", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        ppm: { webviewDir: "webviews" },
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.ppm?.webviewDir).toBe("webviews");
      expect(manifest?.displayName).toBe("test-ext"); // Falls back to name
    });

    it("handles empty contributes", () => {
      const pkg = {
        name: "test-ext",
        version: "1.0.0",
        main: "index.js",
        contributes: {},
      };

      const manifest = service.parseManifest(pkg);

      expect(manifest?.contributes).toEqual({});
    });
  });
});
