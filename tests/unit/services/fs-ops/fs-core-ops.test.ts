import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNotNested,
  copyEntry,
  isCaseOnlyRename,
  moveEntry,
  removeEntry,
  renameEntry,
} from "../../../../src/services/fs-ops/fs-core-ops.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-core-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("copyEntry", () => {
  it("copies a directory tree", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.txt"), "a");
    await copyEntry(join(dir, "src"), join(dir, "dst"));
    expect(readFileSync(join(dir, "dst", "a.txt"), "utf-8")).toBe("a");
  });

  it("refuses an occupied destination with EEXIST", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    await expect(copyEntry(join(dir, "a.txt"), join(dir, "b.txt"))).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("refuses to copy a directory into itself", async () => {
    mkdirSync(join(dir, "src"));
    await expect(copyEntry(join(dir, "src"), join(dir, "src", "inner"))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("renameEntry", () => {
  it("renames a file", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    await renameEntry(join(dir, "a.txt"), join(dir, "b.txt"));
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("rejects a collision", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    await expect(renameEntry(join(dir, "a.txt"), join(dir, "b.txt"))).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("allows a case-only rename", async () => {
    writeFileSync(join(dir, "Foo.txt"), "a");
    await renameEntry(join(dir, "Foo.txt"), join(dir, "foo.txt"));
    expect(readFileSync(join(dir, "foo.txt"), "utf-8")).toBe("a");
  });
});

describe("isCaseOnlyRename", () => {
  it("is false for different names", () => {
    expect(isCaseOnlyRename(join(dir, "a"), join(dir, "b"))).toBe(false);
  });

  it("is false for identical paths", () => {
    expect(isCaseOnlyRename(join(dir, "a"), join(dir, "a"))).toBe(false);
  });

  it.if(process.platform === "win32" || process.platform === "darwin")(
    "is true on a case-insensitive platform",
    () => {
      expect(isCaseOnlyRename(join(dir, "Foo"), join(dir, "foo"))).toBe(true);
    },
  );
});

describe("assertNotNested", () => {
  it("rejects a destination inside the source", () => {
    expect(() => assertNotNested(join(dir, "a"), join(dir, "a", "b"))).toThrow("inside itself");
  });

  it("accepts a sibling destination", () => {
    expect(() => assertNotNested(join(dir, "a"), join(dir, "b"))).not.toThrow();
  });
});

describe("moveEntry", () => {
  it("moves within the same device without a copy fallback", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const result = await moveEntry(join(dir, "a.txt"), join(dir, "moved.txt"));
    expect(result.crossDevice).toBe(false);
    expect(readFileSync(join(dir, "moved.txt"), "utf-8")).toBe("a");
  });

  it("falls back to copy + delete when rename reports EXDEV", async () => {
    mkdirSync(join(dir, "tree"));
    writeFileSync(join(dir, "tree", "f.txt"), "x");
    const exdev = async () => {
      throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
    };
    const result = await moveEntry(join(dir, "tree"), join(dir, "moved"), exdev);
    expect(result.crossDevice).toBe(true);
    expect(readFileSync(join(dir, "moved", "f.txt"), "utf-8")).toBe("x");
    expect(existsSync(join(dir, "tree"))).toBe(false);
  });

  it("propagates a non-EXDEV rename failure", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const boom = async () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    await expect(moveEntry(join(dir, "a.txt"), join(dir, "b.txt"), boom)).rejects.toMatchObject({
      code: "EPERM",
    });
  });
});

describe("removeEntry", () => {
  it("removes a directory tree", async () => {
    mkdirSync(join(dir, "tree", "deep"), { recursive: true });
    writeFileSync(join(dir, "tree", "deep", "f.txt"), "x");
    await removeEntry(join(dir, "tree"));
    expect(existsSync(join(dir, "tree"))).toBe(false);
  });

  it("removes a symlink without touching its target", async () => {
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "keep.txt"), "keep");
    const link = join(dir, "link");
    try {
      symlinkSync(join(dir, "target"), link, "junction");
    } catch {
      return; // link creation needs privileges on some hosts
    }
    await removeEntry(link);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(dir, "target", "keep.txt"), "utf-8")).toBe("keep");
  });

  it("fails on a missing path instead of succeeding silently", async () => {
    await expect(removeEntry(join(dir, "ghost"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
