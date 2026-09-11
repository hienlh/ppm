/**
 * Reading the end of a file, and counting its lines, without holding it.
 *
 * Both replaced a `readFileSync` that was correct while the files were small.
 * The cases that matter here are the ones a whole-file read never had to think
 * about: a slice that begins in the middle of a line, and a byte-level count
 * over text that is not ASCII.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLinesFromTail, tailLines, countLines } from "../../../src/services/file-lines.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ppm-file-lines-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe("picking lines out of a tail slice", () => {
  it("drops the first line when the slice began mid-file", () => {
    // "ne 1" is the tail of a line whose start was never read. A bug report
    // opening with half a sentence is how you know this was skipped.
    expect(lastLinesFromTail("ne 1\nline 2\nline 3\n", 3, true)).toBe("line 2\nline 3");
  });

  it("keeps the first line when the slice is the whole file", () => {
    expect(lastLinesFromTail("line 1\nline 2\n", 3, false)).toBe("line 1\nline 2");
  });

  it("returns fewer than asked rather than padding", () => {
    expect(lastLinesFromTail("only\n", 30, false)).toBe("only");
  });
});

describe("tailLines", () => {
  it("returns every line when the file is smaller than the window", async () => {
    const p = write("small.log", "a\nb\nc\n");
    expect(await tailLines(p, 30)).toBe("a\nb\nc");
  });

  it("returns the last N and nothing earlier", async () => {
    const p = write("many.log", Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const out = await tailLines(p, 3);
    expect(out).toBe("line 4997\nline 4998\nline 4999");
    expect(out).not.toContain("line 0");
  });

  it("reads a bounded window, not the file", async () => {
    // 4 MB of log, a 1 KB window: the answer may only come from the end. If
    // the implementation ever slurps again this still passes on content, so
    // the assertion is on what it cannot have seen.
    const p = write("big.log", "x".repeat(4 * 1024 * 1024) + "\nlast line\n");
    expect(await tailLines(p, 1, 1024)).toBe("last line");
  });

  it("says nothing about an empty file rather than throwing", async () => {
    expect(await tailLines(write("empty.log", ""), 30)).toBe("");
  });
});

describe("countLines", () => {
  it("counts a file that ends with a newline", async () => {
    expect(await countLines(write("a.jsonl", "1\n2\n3\n"))).toBe(3);
  });

  it("counts the last line when it has no trailing newline", async () => {
    expect(await countLines(write("b.jsonl", "1\n2\n3"))).toBe(3);
  });

  it("is zero for an empty file", async () => {
    expect(await countLines(write("c.jsonl", ""))).toBe(0);
  });

  it("counts bytes, and that is still right for multi-byte text", async () => {
    // The whole reason counting 0x0A over raw bytes is safe: every byte of a
    // multi-byte UTF-8 sequence has the high bit set, so none of them can be
    // mistaken for a newline. A transcript full of Vietnamese would otherwise
    // be the case that breaks it.
    const p = write("vn.jsonl", '{"t":"đường dẫn"}\n{"t":"日本語"}\n{"t":"🎉"}\n');
    expect(await countLines(p)).toBe(3);
  });

  it("counts a file larger than one stream chunk", async () => {
    const p = write("big.jsonl", Array.from({ length: 50_000 }, (_, i) => `{"i":${i}}`).join("\n") + "\n");
    expect(await countLines(p)).toBe(50_000);
  });
});
