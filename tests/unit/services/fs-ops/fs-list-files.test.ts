import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "../../../../src/services/fs-ops/fs-list-files.service.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-list-"));
  writeFileSync(join(dir, "root.txt"), "a");
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  writeFileSync(join(dir, "nested", "child.txt"), "b");
  writeFileSync(join(dir, "nested", "deep", "leaf.txt"), "c");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "ignored.txt"), "d");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("list", () => {
  it("returns a promise — the palette listing must not block the event loop", () => {
    const result = list(dir);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it("finds files breadth-first across levels", async () => {
    const files = await list(dir);
    expect(files).toContain(join(dir, "root.txt"));
    expect(files).toContain(join(dir, "nested", "child.txt"));
    expect(files).toContain(join(dir, "nested", "deep", "leaf.txt"));
  });

  it("lists root-level files before descending", async () => {
    const files = await list(dir);
    expect(files[0]).toBe(join(dir, "root.txt"));
  });

  it("skips noise directories", async () => {
    const files = await list(dir);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("refuses a path outside the allowlist", async () => {
    await expect(list("\\\\server\\share")).rejects.toThrow("Access denied");
  });

  it("survives an unreadable directory instead of failing the listing", async () => {
    const files = await list(join(dir, "nested"));
    expect(files).toContain(join(dir, "nested", "child.txt"));
  });
});
