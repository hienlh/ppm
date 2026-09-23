import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  readDesignFileSafe, safeWalkDesignTree, SafeWalkError, type SafeWalkEntry,
} from "../../../src/services/design/design-safe-walk.ts";

async function collect(root: string, opts?: Parameters<typeof safeWalkDesignTree>[1]): Promise<SafeWalkEntry[]> {
  const out: SafeWalkEntry[] = [];
  for await (const entry of safeWalkDesignTree(root, opts)) out.push(entry);
  return out;
}

const posix = process.platform !== "win32";

describe("safeWalkDesignTree", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ppm-safe-walk-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-safe-walk-out-")));
    mkdirSync(join(root, "assets", "img"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<p>hi</p>");
    writeFileSync(join(root, "assets", "img", "a.png"), "png!");
    mkdirSync(join(root, ".design", "history"), { recursive: true });
    writeFileSync(join(root, ".design", "history", "x.txt"), "internal");
    writeFileSync(join(outside, "secret.txt"), "outside");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("yields regular files in sorted order with /-separated relative paths and sizes", async () => {
    const entries = await collect(root);
    expect(entries.map((e) => e.rel)).toEqual(["assets/img/a.png", "index.html"]);
    expect(entries.find((e) => e.rel === "index.html")?.size).toBe(9);
  });

  it("skips the top-level .design directory unless told otherwise", async () => {
    expect((await collect(root)).some((e) => e.rel.startsWith(".design"))).toBe(false);
    expect((await collect(root, { skipDotDesign: false })).map((e) => e.rel)).toContain(".design/history/x.txt");
  });

  it("skips a symlink to a file outside the tree", async () => {
    if (!posix) return;
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    expect((await collect(root)).map((e) => e.rel)).not.toContain("leak.txt");
  });

  it("skips a symlinked directory", async () => {
    symlinkSync(outside, join(root, "linked"), posix ? "dir" : "junction");
    const rels = (await collect(root)).map((e) => e.rel);
    expect(rels.some((r) => r.startsWith("linked"))).toBe(false);
  });

  it("never reads a symlink to ppm.db", async () => {
    if (!posix) return;
    const db = join(getPpmDir(), "ppm.db");
    writeFileSync(db, "credentials");
    symlinkSync(db, join(root, "ppm.db"));
    const entries = await collect(root);
    expect(entries.map((e) => e.rel)).not.toContain("ppm.db");
  });

  it("skips a FIFO instead of hanging on it", async () => {
    if (!posix) return;
    const made = Bun.spawnSync(["mkfifo", join(root, "pipe")]);
    if (made.exitCode !== 0) return;
    const entries = await collect(root);
    expect(entries.map((e) => e.rel)).toEqual(["assets/img/a.png", "index.html"]);
  });

  it("refuses to walk a tree inside the PPM directory", async () => {
    const inside = join(getPpmDir(), "designs-under-ppm");
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "index.html"), "x");
    try {
      await expect(collect(inside)).rejects.toBeInstanceOf(SafeWalkError);
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  });

  it("refuses a root that is a symlink", async () => {
    const link = join(outside, "root-link");
    symlinkSync(root, link, posix ? "dir" : "junction");
    await expect(collect(link)).rejects.toMatchObject({ code: "EROOT" });
  });

  it("refuses a tree nested deeper than the limit", async () => {
    mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "d", "deep.txt"), "x");
    await expect(collect(root, { maxDepth: 2 })).rejects.toMatchObject({ code: "EDEPTH" });
  });
});

describe("readDesignFileSafe", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ppm-safe-read-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads a regular file and enforces a byte limit", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    expect((await readDesignFileSafe(join(root, "a.txt"))).toString()).toBe("hello");
    await expect(readDesignFileSafe(join(root, "a.txt"), 2)).rejects.toMatchObject({ code: "ETOOBIG" });
  });

  it("will not open through a symlink swapped in after the walk", async () => {
    if (!posix) return;
    writeFileSync(join(root, "real.txt"), "secret");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    await expect(readDesignFileSafe(join(root, "link.txt"))).rejects.toBeDefined();
  });
});
