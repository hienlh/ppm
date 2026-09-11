import { describe, it, expect } from "bun:test";
import {
  getBuiltinSlashItems,
  getHostBuiltinSlashItems,
} from "../../../../src/services/slash-discovery/builtin-commands.ts";

describe("getHostBuiltinSlashItems", () => {
  it("keeps the built-ins PPM and the web client intercept themselves", () => {
    const names = getHostBuiltinSlashItems().map((i) => i.name);
    // These run before any provider is consulted, so a codex tab must still
    // offer them — filtering the picker by provider should not cost them.
    expect(names).toContain("clear");
    expect(names).toContain("skills");
    expect(names).toContain("version");
  });

  it("drops the ones that only the Claude SDK executes", () => {
    const names = getHostBuiltinSlashItems().map((i) => i.name);
    for (const sdkOnly of ["help", "status", "cost", "compact", "model", "config", "memory"]) {
      expect(names).not.toContain(sdkOnly);
    }
  });

  it("carries no sdk-handled item at all", () => {
    expect(getHostBuiltinSlashItems().every((i) => i.handler !== "sdk")).toBe(true);
  });

  it("is a strict subset of the full built-in list", () => {
    const all = getBuiltinSlashItems();
    const host = getHostBuiltinSlashItems();
    expect(host.length).toBeGreaterThan(0);
    expect(host.length).toBeLessThan(all.length);
    const allNames = new Set(all.map((i) => i.name));
    expect(host.every((i) => allNames.has(i.name))).toBe(true);
  });

  it("leaves the full list untouched", () => {
    // Callers on the Claude path still get every built-in.
    expect(getBuiltinSlashItems().map((i) => i.name)).toContain("compact");
  });
});
