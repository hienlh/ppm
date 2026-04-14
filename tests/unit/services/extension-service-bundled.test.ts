import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { extensionService } from "../../../src/services/extension.service.ts";

describe("ExtensionService bundled extensions", () => {
  describe("isBundled", () => {
    it("returns false for unknown extension", () => {
      const result = extensionService.isBundled("nonexistent-ext");
      expect(result).toBe(false);
    });

    it("returns true for bundled extension after discover", async () => {
      // Run discover to populate bundled IDs
      await extensionService.discover();

      // ext-git-graph should be bundled
      const result = extensionService.isBundled("@ppm/ext-git-graph");
      expect(result).toBe(true);
    });

    it("returns false for non-bundled extension", async () => {
      // User extensions should not be marked as bundled
      const result = extensionService.isBundled("some-user-extension");
      expect(result).toBe(false);
    });
  });

  describe("discover bundled extensions", () => {
    it("discovers bundled and user extensions", async () => {
      const manifests = await extensionService.discover();

      // Should return at least the bundled extension
      expect(manifests.length).toBeGreaterThan(0);

      // Check for ext-git-graph
      const gitGraph = manifests.find(m => m.id === "@ppm/ext-git-graph");
      expect(gitGraph).toBeTruthy();
      expect(gitGraph?.version).toBeTruthy();
    });

    it("populates extensionPaths map", async () => {
      await extensionService.discover();

      // After discover, extensionPaths should have bundled extensions
      // We can't directly access the private map, but we can verify via isBundled
      const isBundled = extensionService.isBundled("@ppm/ext-git-graph");
      expect(isBundled).toBe(true);
    });

    it("marks bundled extensions in bundledIds set", async () => {
      await extensionService.discover();

      // Bundled extensions should return true for isBundled
      const bundledCheck = extensionService.isBundled("@ppm/ext-git-graph");
      expect(bundledCheck).toBe(true);
    });
  });

  describe("remove bundled extension protection", () => {
    it("throws error when attempting to remove bundled extension", async () => {
      await extensionService.discover();

      // Attempting to remove a bundled extension should throw
      try {
        await extensionService.remove("@ppm/ext-git-graph");
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect((e as Error).message).toContain("Cannot remove bundled extension");
      }
    });

    it("error message suggests disabling instead", async () => {
      await extensionService.discover();

      try {
        await extensionService.remove("@ppm/ext-git-graph");
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect((e as Error).message).toContain("ppm ext disable");
      }
    });

    it("allows removing non-bundled extensions", async () => {
      // Non-bundled extensions should not trigger the bundled check
      // (actual removal would fail for other reasons in test, but should pass the bundled check)
      await extensionService.discover();

      try {
        await extensionService.remove("fake-user-extension");
        // Expected to fail with "not found in DB" or similar, not bundled error
      } catch (e) {
        expect((e as Error).message).not.toContain("Cannot remove bundled extension");
      }
    });
  });
});
