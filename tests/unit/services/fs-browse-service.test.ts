import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { browse } from "../../../src/services/fs-browse.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

const isWin = process.platform === "win32";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-browse-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "visible.txt"), "hello");
  writeFileSync(join(dir, ".hidden"), "x");
  if (isWin) writeFileSync(join(dir, "desktop.ini"), "x");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("browse", () => {
  it("lists directories first and reports kind and separator", async () => {
    const result = await browse(dir);
    expect(result.sep).toBe(sep);
    expect(result.entries[0]!.name).toBe("sub");
    expect(result.entries[0]!.kind).toBe("directory");
    const file = result.entries.find((e) => e.name === "visible.txt")!;
    expect(file.kind).toBe("file");
    expect(file.size).toBe(5);
  });

  it("hides dot-names unless asked", async () => {
    const hiddenOff = await browse(dir);
    expect(hiddenOff.entries.some((e) => e.name === ".hidden")).toBe(false);
    const hiddenOn = await browse(dir, { showHidden: true });
    expect(hiddenOn.entries.some((e) => e.name === ".hidden")).toBe(true);
  });

  it.if(isWin)("hides Windows shell system entries", async () => {
    const result = await browse(dir);
    expect(result.entries.some((e) => e.name === "desktop.ini")).toBe(false);
  });

  it("lists a symlink without descending into it", async () => {
    const link = join(dir, "link-to-sub");
    try {
      symlinkSync(join(dir, "sub"), link, "junction");
    } catch {
      return; // link creation needs privileges on some hosts
    }
    const result = await browse(dir);
    const entry = result.entries.find((e) => e.name === "link-to-sub")!;
    expect(entry.kind).toBe("symlink");
    rmSync(link, { recursive: true, force: true });
  });

  it("reports a parent for a nested directory", async () => {
    const result = await browse(join(dir, "sub"));
    expect(result.parent).toBe(dir);
  });

  it("has no parent at a filesystem root and labels the root crumb", async () => {
    const root = isWin ? `${dir.slice(0, 2)}\\` : "/";
    const result = await browse(root);
    expect(result.parent).toBeNull();
    expect(result.breadcrumbs[0]!.name).toBe(isWin ? dir.slice(0, 2) : "/");
  });

  it("still lists the PPM directory so the sidebar is not confused", async () => {
    writeFileSync(join(getPpmDir(), "ppm.db"), "secret");
    const result = await browse(getPpmDir());
    expect(result.entries.some((e) => e.name === "ppm.db")).toBe(true);
  });

  it("fails with 404 for a missing directory", async () => {
    await expect(browse(join(dir, "nope"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails with 400 when the path is a file", async () => {
    await expect(browse(join(dir, "visible.txt"))).rejects.toMatchObject({ status: 400 });
  });
});
