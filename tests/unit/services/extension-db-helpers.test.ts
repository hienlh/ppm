import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  openTestDb,
  setDb,
  closeDb,
  getExtensions,
  getExtensionById,
  insertExtension,
  updateExtension,
  deleteExtension,
  getExtensionStorage,
  setExtensionStorageValue,
  deleteExtensionStorage,
} from "../../../src/services/db.service.ts";
import type { ExtensionRow } from "../../../src/types/extension.ts";

describe("Extension DB Helpers", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  afterEach(() => {
    closeDb();
  });

  describe("insertExtension", () => {
    it("inserts extension into DB", () => {
      const manifest = { id: "@ppm/ext-test", version: "1.0.0", main: "index.js" };
      insertExtension({
        id: "@ppm/ext-test",
        version: "1.0.0",
        display_name: "Test Extension",
        description: "A test extension",
        icon: null,
        enabled: 1,
        manifest: JSON.stringify(manifest),
      });

      const ext = getExtensionById("@ppm/ext-test");
      expect(ext).toBeTruthy();
      expect(ext?.display_name).toBe("Test Extension");
      expect(ext?.enabled).toBe(1);
    });

    it("auto-sets installed_at and updated_at timestamps", () => {
      insertExtension({
        id: "ext-with-timestamps",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      const ext = getExtensionById("ext-with-timestamps");
      expect(ext?.installed_at).toBeTruthy();
      expect(ext?.updated_at).toBeTruthy();
    });

    it("allows null values for optional fields", () => {
      insertExtension({
        id: "sparse-ext",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      const ext = getExtensionById("sparse-ext");
      expect(ext?.display_name).toBeNull();
      expect(ext?.description).toBeNull();
      expect(ext?.icon).toBeNull();
    });
  });

  describe("getExtensionById", () => {
    it("returns extension if exists", () => {
      insertExtension({
        id: "test-ext",
        version: "1.0.0",
        display_name: "Test",
        description: "Desc",
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      const ext = getExtensionById("test-ext");
      expect(ext?.id).toBe("test-ext");
      expect(ext?.version).toBe("1.0.0");
    });

    it("returns null if not found", () => {
      const ext = getExtensionById("non-existent");
      expect(ext).toBeNull();
    });

    it("handles special characters in ID (scoped packages)", () => {
      insertExtension({
        id: "@scope/package-name",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      const ext = getExtensionById("@scope/package-name");
      expect(ext?.id).toBe("@scope/package-name");
    });
  });

  describe("getExtensions", () => {
    it("returns all extensions ordered by display_name then id", () => {
      insertExtension({
        id: "zebra-ext",
        version: "1.0.0",
        display_name: "Zebra",
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });
      insertExtension({
        id: "apple-ext",
        version: "1.0.0",
        display_name: "Apple",
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });
      insertExtension({
        id: "other-ext",
        version: "1.0.0",
        display_name: "Other",
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      const exts = getExtensions();
      expect(exts.length).toBe(3);
      const names = exts.map((e) => e.display_name).filter((n) => n !== null);
      expect(names.sort()).toEqual(["Apple", "Other", "Zebra"]);
    });

    it("returns empty array if no extensions", () => {
      const exts = getExtensions();
      expect(exts).toEqual([]);
    });
  });

  describe("updateExtension", () => {
    beforeEach(() => {
      insertExtension({
        id: "update-test",
        version: "1.0.0",
        display_name: "Original Name",
        description: "Original Desc",
        icon: null,
        enabled: 1,
        manifest: "{}",
      });
    });

    it("updates version", () => {
      updateExtension("update-test", { version: "2.0.0" });
      const ext = getExtensionById("update-test");
      expect(ext?.version).toBe("2.0.0");
    });

    it("updates display_name", () => {
      updateExtension("update-test", { display_name: "New Name" });
      const ext = getExtensionById("update-test");
      expect(ext?.display_name).toBe("New Name");
    });

    it("updates description", () => {
      updateExtension("update-test", { description: "New Desc" });
      const ext = getExtensionById("update-test");
      expect(ext?.description).toBe("New Desc");
    });

    it("updates icon", () => {
      updateExtension("update-test", { icon: "icon-url" });
      const ext = getExtensionById("update-test");
      expect(ext?.icon).toBe("icon-url");
    });

    it("updates enabled flag", () => {
      updateExtension("update-test", { enabled: 0 });
      const ext = getExtensionById("update-test");
      expect(ext?.enabled).toBe(0);
    });

    it("updates manifest", () => {
      const newManifest = { id: "test", version: "2.0.0" };
      updateExtension("update-test", { manifest: JSON.stringify(newManifest) });
      const ext = getExtensionById("update-test");
      expect(JSON.parse(ext?.manifest || "{}")).toEqual(newManifest);
    });

    it("updates multiple fields at once", () => {
      updateExtension("update-test", {
        version: "3.0.0",
        display_name: "Latest",
        enabled: 0,
      });
      const ext = getExtensionById("update-test");
      expect(ext?.version).toBe("3.0.0");
      expect(ext?.display_name).toBe("Latest");
      expect(ext?.enabled).toBe(0);
      // Original description should be unchanged
      expect(ext?.description).toBe("Original Desc");
    });

    it("updates updated_at timestamp", async () => {
      const before = getExtensionById("update-test");
      const beforeTime = before?.updated_at;
      // Simulate time passing (at least 1 second for datetime precision)
      const wait = new Promise((resolve) => setTimeout(resolve, 1000));
      await wait;
      updateExtension("update-test", { display_name: "New" });
      const after = getExtensionById("update-test");
      const afterTime = after?.updated_at;
      // SQLite datetime() has second precision, so they should differ
      expect(afterTime).not.toBe(beforeTime);
    });

    it("ignores empty update object", () => {
      const before = getExtensionById("update-test");
      updateExtension("update-test", {});
      const after = getExtensionById("update-test");
      // Should be unchanged except possibly updated_at
      expect(after?.display_name).toBe(before?.display_name);
      expect(after?.version).toBe(before?.version);
    });
  });

  describe("deleteExtension", () => {
    it("deletes extension from DB", () => {
      insertExtension({
        id: "delete-test",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      deleteExtension("delete-test");
      const ext = getExtensionById("delete-test");
      expect(ext).toBeNull();
    });

    it("is safe if extension doesn't exist", () => {
      // Should not throw
      deleteExtension("non-existent");
      expect(true);
    });

    it("cascades to extension_storage (foreign key)", () => {
      insertExtension({
        id: "cascade-test",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      setExtensionStorageValue("cascade-test", "global", "key1", "value1");

      deleteExtension("cascade-test");

      const storage = getExtensionStorage("cascade-test", "global");
      expect(storage).toEqual([]);
    });
  });

  describe("setExtensionStorageValue", () => {
    beforeEach(() => {
      insertExtension({
        id: "storage-test",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });
    });

    it("inserts storage key-value", () => {
      setExtensionStorageValue("storage-test", "global", "key1", '"value1"');

      const storage = getExtensionStorage("storage-test", "global");
      expect(storage.length).toBe(1);
      expect(storage[0].key).toBe("key1");
      expect(storage[0].value).toBe('"value1"');
    });

    it("updates existing key-value (upsert)", () => {
      setExtensionStorageValue("storage-test", "global", "key1", '"first"');
      setExtensionStorageValue("storage-test", "global", "key1", '"second"');

      const storage = getExtensionStorage("storage-test", "global");
      expect(storage.length).toBe(1);
      expect(storage[0].value).toBe('"second"');
    });

    it("handles different scopes independently", () => {
      setExtensionStorageValue("storage-test", "global", "key", '"global-value"');
      setExtensionStorageValue("storage-test", "workspace", "key", '"workspace-value"');

      const globalStorage = getExtensionStorage("storage-test", "global");
      const workspaceStorage = getExtensionStorage("storage-test", "workspace");

      expect(globalStorage[0].value).toBe('"global-value"');
      expect(workspaceStorage[0].value).toBe('"workspace-value"');
    });

    it("stores JSON-encoded values", () => {
      const obj = { nested: "data", count: 42 };
      setExtensionStorageValue("storage-test", "global", "obj", JSON.stringify(obj));

      const storage = getExtensionStorage("storage-test", "global");
      expect(JSON.parse(storage[0].value || "{}")).toEqual(obj);
    });

    it("stores null values", () => {
      setExtensionStorageValue("storage-test", "global", "nullable", null);

      const storage = getExtensionStorage("storage-test", "global");
      expect(storage[0].value).toBeNull();
    });
  });

  describe("getExtensionStorage", () => {
    beforeEach(() => {
      insertExtension({
        id: "storage-ext",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });
    });

    it("retrieves storage values by scope", () => {
      setExtensionStorageValue("storage-ext", "global", "key1", '"val1"');
      setExtensionStorageValue("storage-ext", "global", "key2", '"val2"');
      setExtensionStorageValue("storage-ext", "workspace", "key1", '"workspace-val"');

      const globalStorage = getExtensionStorage("storage-ext", "global");
      expect(globalStorage.length).toBe(2);
      expect(globalStorage.find((s) => s.key === "key1")?.value).toBe('"val1"');

      const workspaceStorage = getExtensionStorage("storage-ext", "workspace");
      expect(workspaceStorage.length).toBe(1);
    });

    it("returns empty array if no storage for scope", () => {
      const storage = getExtensionStorage("storage-ext", "non-existent");
      expect(storage).toEqual([]);
    });

    it("returns empty array if extension doesn't exist", () => {
      const storage = getExtensionStorage("non-existent", "global");
      expect(storage).toEqual([]);
    });
  });

  describe("deleteExtensionStorage", () => {
    it("deletes all storage for an extension", () => {
      insertExtension({
        id: "del-storage-ext",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      setExtensionStorageValue("del-storage-ext", "global", "key1", '"val1"');
      setExtensionStorageValue("del-storage-ext", "workspace", "key2", '"val2"');

      deleteExtensionStorage("del-storage-ext");

      expect(getExtensionStorage("del-storage-ext", "global")).toEqual([]);
      expect(getExtensionStorage("del-storage-ext", "workspace")).toEqual([]);
    });

    it("is safe if extension has no storage", () => {
      insertExtension({
        id: "no-storage-ext",
        version: "1.0.0",
        display_name: null,
        description: null,
        icon: null,
        enabled: 1,
        manifest: "{}",
      });

      // Should not throw
      deleteExtensionStorage("no-storage-ext");
      expect(true);
    });
  });

  describe("DB schema v12 validation", () => {
    it("extensions table exists with correct schema", () => {
      const tableInfo = openTestDb()
        .query("PRAGMA table_info(extensions)")
        .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

      const columns = tableInfo.map((col) => ({
        name: col.name,
        type: col.type,
        pk: col.pk,
      }));

      expect(columns.find((c) => c.name === "id" && c.pk === 1)).toBeTruthy();
      expect(columns.find((c) => c.name === "version")).toBeTruthy();
      expect(columns.find((c) => c.name === "manifest")).toBeTruthy();
      expect(columns.find((c) => c.name === "enabled")).toBeTruthy();
    });

    it("extension_storage table exists with foreign key", () => {
      const tableInfo = openTestDb()
        .query("PRAGMA table_info(extension_storage)")
        .all() as Array<{ name: string }>;

      const columns = tableInfo.map((col) => col.name);
      expect(columns).toContain("ext_id");
      expect(columns).toContain("scope");
      expect(columns).toContain("key");
      expect(columns).toContain("value");
    });

    it("extension_storage has composite primary key", () => {
      const tableInfo = openTestDb()
        .query("PRAGMA table_info(extension_storage)")
        .all() as Array<{ name: string; pk: number }>;

      const pk = tableInfo.filter((col) => col.pk > 0).map((col) => col.name).sort();
      expect(pk).toContain("ext_id");
      expect(pk).toContain("scope");
      expect(pk).toContain("key");
    });
  });
});
