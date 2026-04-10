import { describe, it, expect } from "bun:test";
import {
  getBuiltinSlashItems,
  getBuiltinByName,
  isPpmHandled,
} from "../../../../src/services/slash-discovery/builtin-commands.ts";

describe("getBuiltinSlashItems", () => {
  it("returns array of slash items with correct shape", () => {
    const items = getBuiltinSlashItems();

    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it("returns items with required fields", () => {
    const items = getBuiltinSlashItems();

    for (const item of items) {
      expect(item.name).toBeTruthy();
      expect(typeof item.name).toBe("string");
      expect(item.description).toBeTruthy();
      expect(typeof item.description).toBe("string");
      expect(item.type).toBe("builtin");
      expect(item.scope).toBe("bundled");
    }
  });

  it("has no duplicate names", () => {
    const items = getBuiltinSlashItems();
    const names = items.map((i) => i.name);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
  });

  it("includes expected built-in commands", () => {
    const items = getBuiltinSlashItems();
    const names = items.map((i) => i.name);

    expect(names).toContain("skills");
    expect(names).toContain("help");
    expect(names).toContain("version");
    expect(names).toContain("status");
    expect(names).toContain("cost");
  });

  it("each item has valid category from session, tools, or config", () => {
    const items = getBuiltinSlashItems();
    const validCategories = ["session", "tools", "config"];

    for (const item of items) {
      expect(validCategories).toContain(item.category);
    }
  });

  it("items with argumentHint have it as optional property", () => {
    const items = getBuiltinSlashItems();

    for (const item of items) {
      if (item.argumentHint) {
        expect(typeof item.argumentHint).toBe("string");
      }
    }
  });

  it("items can have aliases array", () => {
    const items = getBuiltinSlashItems();
    const itemWithAlias = items.find((i) => i.aliases);

    if (itemWithAlias) {
      expect(Array.isArray(itemWithAlias.aliases)).toBe(true);
    }
  });

  it("returns expected count of items (9 built-in commands)", () => {
    const items = getBuiltinSlashItems();
    expect(items.length).toBe(9);
  });
});

describe("getBuiltinByName", () => {
  it("finds command by exact name", () => {
    const cmd = getBuiltinByName("skills");

    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe("skills");
    expect(cmd!.summary).toBeTruthy();
  });

  it("finds command by alias", () => {
    const cmd = getBuiltinByName("sk");

    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe("skills");
  });

  it("is case-insensitive for name lookup", () => {
    const cmd1 = getBuiltinByName("skills");
    const cmd2 = getBuiltinByName("SKILLS");
    const cmd3 = getBuiltinByName("Skills");

    expect(cmd1).toEqual(cmd2);
    expect(cmd2).toEqual(cmd3);
  });

  it("is case-insensitive for alias lookup", () => {
    const cmd1 = getBuiltinByName("sk");
    const cmd2 = getBuiltinByName("SK");
    const cmd3 = getBuiltinByName("Sk");

    expect(cmd1).toEqual(cmd2);
    expect(cmd2).toEqual(cmd3);
  });

  it("returns undefined for non-existent command", () => {
    const cmd = getBuiltinByName("nonexistent");

    expect(cmd).toBeUndefined();
  });

  it("returns command with all required properties", () => {
    const cmd = getBuiltinByName("version");

    expect(cmd).toBeTruthy();
    expect(cmd!.name).toBe("version");
    expect(cmd!.summary).toBeTruthy();
    expect(cmd!.category).toBeTruthy();
    expect(["ppm", "sdk"]).toContain(cmd!.handler);
  });

  it("finds all known commands by name", () => {
    const names = [
      "skills",
      "version",
      "help",
      "status",
      "cost",
      "compact",
      "model",
      "config",
      "memory",
    ];

    for (const name of names) {
      const cmd = getBuiltinByName(name);
      expect(cmd).toBeTruthy();
      expect(cmd!.name).toBe(name);
    }
  });

  it("returns command with handler property (ppm or sdk)", () => {
    const ppmCmd = getBuiltinByName("skills");
    const sdkCmd = getBuiltinByName("help");

    expect(ppmCmd!.handler).toBe("ppm");
    expect(sdkCmd!.handler).toBe("sdk");
  });
});

describe("isPpmHandled", () => {
  it("returns true for PPM-handled commands", () => {
    expect(isPpmHandled("skills")).toBe(true);
    expect(isPpmHandled("version")).toBe(true);
  });

  it("returns false for SDK-passthrough commands", () => {
    expect(isPpmHandled("help")).toBe(false);
    expect(isPpmHandled("status")).toBe(false);
    expect(isPpmHandled("cost")).toBe(false);
    expect(isPpmHandled("compact")).toBe(false);
    expect(isPpmHandled("model")).toBe(false);
    expect(isPpmHandled("config")).toBe(false);
    expect(isPpmHandled("memory")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPpmHandled("SKILLS")).toBe(true);
    expect(isPpmHandled("Skills")).toBe(true);
    expect(isPpmHandled("HELP")).toBe(false);
    expect(isPpmHandled("Help")).toBe(false);
  });

  it("returns false for non-existent commands", () => {
    expect(isPpmHandled("nonexistent")).toBe(false);
  });

  it("handles alias names correctly", () => {
    // "sk" is alias for "skills", which is PPM-handled
    expect(isPpmHandled("sk")).toBe(true);
  });

  it("classifies exactly 2 commands as PPM-handled (skills, version)", () => {
    const ppmHandledNames = ["skills", "version"];
    for (const name of ppmHandledNames) {
      expect(isPpmHandled(name)).toBe(true);
    }

    // Verify all other commands are SDK-passthrough
    const allItems = getBuiltinSlashItems();
    const actualPpmCount = allItems.filter((item) =>
      isPpmHandled(item.name),
    ).length;

    expect(actualPpmCount).toBe(2);
  });
});
