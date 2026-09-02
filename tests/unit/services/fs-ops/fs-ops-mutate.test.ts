import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  deletePath,
  makeDir,
  renamePath,
  touchFile,
} from "../../../../src/services/fs-ops/fs-ops-mutate.service.ts";
import { copyPath, movePath } from "../../../../src/services/fs-ops/fs-ops-copy-move.service.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-mutate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renamePath", () => {
  it("renames inside the same directory", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const result = await renamePath(join(dir, "a.txt"), "b.txt");
    expect(result.to).toBe(join(dir, "b.txt"));
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
  });

  it("rejects a name containing a path separator", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    await expect(renamePath(join(dir, "a.txt"), "../escape.txt")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses to rename a protected root", async () => {
    await expect(renamePath(homedir(), "somewhere-else")).rejects.toMatchObject({ status: 403 });
  });
});

describe("deletePath", () => {
  it("permanently removes a directory tree", async () => {
    mkdirSync(join(dir, "tree"));
    writeFileSync(join(dir, "tree", "f.txt"), "x");
    await deletePath(join(dir, "tree"));
    expect(existsSync(join(dir, "tree"))).toBe(false);
  });

  it("removes a symlink and keeps its target", async () => {
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "keep.txt"), "keep");
    const link = join(dir, "link");
    try {
      symlinkSync(join(dir, "target"), link, "junction");
    } catch {
      return; // link creation needs privileges on some hosts
    }
    await deletePath(link);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(dir, "target", "keep.txt"))).toBe(true);
  });

  it("refuses a protected root", async () => {
    await expect(deletePath(homedir())).rejects.toMatchObject({ status: 403 });
  });
});

describe("touchFile / makeDir", () => {
  it("creates an empty file", async () => {
    await touchFile(join(dir, "new.txt"));
    expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("");
  });

  it("refuses to clobber an existing file", async () => {
    writeFileSync(join(dir, "new.txt"), "keep");
    await expect(touchFile(join(dir, "new.txt"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("keep");
  });

  it("creates a directory and reports a collision", async () => {
    await makeDir(join(dir, "folder"));
    expect(existsSync(join(dir, "folder"))).toBe(true);
    await expect(makeDir(join(dir, "folder"))).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("copyPath / movePath", () => {
  it("copies a file", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const result = await copyPath(join(dir, "a.txt"), join(dir, "b.txt"));
    expect(result.destination).toBe(join(dir, "b.txt"));
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("a");
  });

  it("reports a missing source as ENOENT", async () => {
    await expect(copyPath(join(dir, "ghost"), join(dir, "b"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("moves a directory", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "f.txt"), "x");
    await movePath(join(dir, "src"), join(dir, "dst"));
    expect(existsSync(join(dir, "src"))).toBe(false);
    expect(readFileSync(join(dir, "dst", "f.txt"), "utf-8")).toBe("x");
  });

  it("refuses to move a protected root", async () => {
    await expect(movePath(homedir(), join(dir, "home-copy"))).rejects.toMatchObject({
      status: 403,
    });
  });

  it.if(process.platform === "win32")("refuses a UNC destination, which is unsupported", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    await expect(
      copyPath(join(dir, "a.txt"), "\\\\server\\share\\a.txt"),
    ).rejects.toThrow("Access denied");
  });
});
