import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeGen, decodeDesignText, readDesignSource, writeDesignSource,
} from "../../../src/services/design/source/design-source-file.ts";
import { DESIGN_GEN_RE } from "../../../src/shared/design-bridge-protocol.ts";

describe("design source files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ppm-design-source-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("computes a 16-hex gen over the text", () => {
    const gen = computeGen("<p>x</p>");
    expect(gen).toMatch(DESIGN_GEN_RE);
    expect(computeGen("<p>x</p>")).toBe(gen);
    expect(computeGen("<p>y</p>")).not.toBe(gen);
  });

  it("strips a BOM before hashing, so the gen names the text offsets are counted in", () => {
    const withBom = decodeDesignText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<p>é</p>")]));
    const without = decodeDesignText(new TextEncoder().encode("<p>é</p>"));
    expect(withBom).toEqual({ text: "<p>é</p>", bom: true, gen: without.gen });
    expect(without.bom).toBe(false);
  });

  it("refuses invalid UTF-8 unless asked to be lossy", () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0x3c]);
    expect(() => decodeDesignText(bytes)).toThrow(/UTF-8/);
    expect(decodeDesignText(bytes, { lossy: true }).text).toBe("<p>�<");
  });

  it("round-trips through write, keeping the BOM and CRLF byte for byte", async () => {
    const path = join(dir, "index.html");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<html>\r\n<p>😀</p>\r\n</html>")]);
    writeFileSync(path, original);
    const read = await readDesignSource(path);
    expect(read.bom).toBe(true);
    const gen = await writeDesignSource(path, read.text, { bom: read.bom });
    expect(gen).toBe(read.gen);
    expect(readFileSync(path).equals(original)).toBe(true);

    const edited = read.text.replace("😀", "🎉");
    const next = await writeDesignSource(path, edited, { bom: false });
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect((await readDesignSource(path)).gen).toBe(next);
  });

  it("rejects text that still carries a BOM, and files over the size cap", async () => {
    const path = join(dir, "a.css");
    await expect(writeDesignSource(path, "﻿p{}", { bom: false })).rejects.toThrow(/BOM/);
    writeFileSync(path, "x".repeat(64));
    await expect(readDesignSource(path, { maxBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });
});
