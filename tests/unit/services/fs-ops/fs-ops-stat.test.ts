import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statPath } from "../../../../src/services/fs-ops/fs-ops-stat.service.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-stat-"));
  mkdirSync(join(dir, "folder"));
  writeFileSync(join(dir, "folder", "one.txt"), "1");
  writeFileSync(join(dir, "folder", "two.txt"), "2");
  writeFileSync(join(dir, "file.txt"), "hello");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("statPath", () => {
  it("describes a file", async () => {
    const st = await statPath(join(dir, "file.txt"));
    expect(st.kind).toBe("file");
    expect(st.name).toBe("file.txt");
    expect(st.size).toBe(5);
    expect(st.isHidden).toBe(false);
    expect(typeof st.mtime).toBe("string");
  });

  it("counts the children of a directory", async () => {
    const st = await statPath(join(dir, "folder"));
    expect(st.kind).toBe("directory");
    expect(st.childCount).toBe(2);
    expect(st.truncated).toBeUndefined();
  });

  it("marks dot-names as hidden", async () => {
    writeFileSync(join(dir, ".secret"), "s");
    expect((await statPath(join(dir, ".secret"))).isHidden).toBe(true);
  });

  it("reports a symlink as a link, not as its target", async () => {
    const link = join(dir, "link.txt");
    try {
      symlinkSync(join(dir, "file.txt"), link);
    } catch {
      return; // link creation needs privileges on some hosts
    }
    const st = await statPath(link);
    expect(st.kind).toBe("symlink");
    expect(st.target).toContain("file.txt");
  });

  it("fails with ENOENT for a missing path", async () => {
    await expect(statPath(join(dir, "ghost"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.if(process.platform === "win32")("refuses a UNC share, which is unsupported", async () => {
    await expect(statPath("\\\\server\\share\\file.txt")).rejects.toThrow("Access denied");
  });
});
