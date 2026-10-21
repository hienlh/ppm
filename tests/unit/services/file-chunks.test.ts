import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readFileChunks } from "../../../src/services/file-chunks.ts";
import { readLines } from "../../../src/services/read-lines.ts";

let dir: string;
let file: string;
const content = Array.from({ length: 5000 }, (_, i) => `{"line":${i},"pad":"${"x".repeat(i % 97)}"}`).join("\n") + "\n";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "file-chunks-"));
  file = join(dir, "t.jsonl");
  writeFileSync(file, content);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function collect(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

describe("readFileChunks", () => {
  it("yields the whole file in order, in chunks of the asked size", async () => {
    const sizes: number[] = [];
    const parts: Uint8Array[] = [];
    for await (const c of readFileChunks(file, { chunkBytes: 4096 })) { sizes.push(c.length); parts.push(c); }
    expect(Buffer.concat(parts).toString()).toBe(content);
    expect(sizes.slice(0, -1).every((s) => s === 4096)).toBe(true);
  });

  it("hands out a fresh buffer per chunk, so a kept chunk survives the next read", async () => {
    const it = readFileChunks(file, { chunkBytes: 1024 });
    const first = (await it.next()).value as Uint8Array;
    const snapshot = Buffer.from(first).toString();
    await it.next();
    await it.return(undefined);
    expect(Buffer.from(first).toString()).toBe(snapshot);
    expect(snapshot).toBe(content.slice(0, 1024));
  });

  it("reads [fromByte, toByte) and stops at the end of the file", async () => {
    expect((await collect(readFileChunks(file, { fromByte: 10, toByte: 50 }))).toString()).toBe(content.slice(10, 50));
    const size = statSync(file).size;
    expect((await collect(readFileChunks(file, { fromByte: size - 5, toByte: size + 1000 }))).toString()).toBe(content.slice(-5));
    expect((await collect(readFileChunks(file, { fromByte: size }))).length).toBe(0);
  });

  it("reads an empty file as nothing", async () => {
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect((await collect(readFileChunks(empty))).length).toBe(0);
  });

  it("closes the file when the caller stops early, so it can be deleted at once", async () => {
    const victim = join(dir, "early.jsonl");
    writeFileSync(victim, content);
    for await (const _ of readFileChunks(victim, { chunkBytes: 128 })) break;
    // On Windows an open handle makes this throw EBUSY/EPERM.
    rmSync(victim);
    expect(readdirSync(dir)).not.toContain("early.jsonl");
  });
});

describe("readLines over readFileChunks", () => {
  it("yields every line of the file", async () => {
    const lines: string[] = [];
    for await (const l of readLines(file)) lines.push(l);
    expect(lines).toEqual(content.trimEnd().split("\n"));
  });

  it("drops the partial first record of a window and stops at toByte", async () => {
    const offsets: number[] = [];
    for (let i = 0, at = 0; i < 4; i++) { offsets.push(at); at = content.indexOf("\n", at) + 1; }
    const lines: string[] = [];
    // From inside record 1 up to the start of record 3: only record 2 is whole.
    for await (const l of readLines(file, offsets[1]! + 3, offsets[3])) lines.push(l);
    expect(lines).toEqual([content.split("\n")[2]!]);
  });
});

describe("no Bun.file().stream() reads", () => {
  // On Bun 1.3.10 (Windows) a full read through a BunFile's stream keeps about the file's size
  // in native memory, forever: it took the server to 25 GB. Read with `readFileChunks`, or hand
  // a `Bun.file(...)` itself to `new Response` — never its `.stream()`.
  it("is not used anywhere in src", () => {
    const root = join(import.meta.dir, "../../../src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, "");
            if (/^\s*\*/.test(code)) return;
            if (/\.stream\(\)/.test(code)) offenders.push(`${relative(root, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  }, 20_000); // ~2,000 files: well under a second warm, slower on a cold disk cache.
});
