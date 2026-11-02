import { describe, it, expect } from "bun:test";
import { heapStats } from "bun:jsc";
import { secretMasker, SECRET_MASK } from "../../../../src/services/schedule-script/secret-mask.ts";
import { LogRing, MAX_LINE_CHARS, MAX_READ_LINE_CHARS, RunLog, readLines } from "../../../../src/services/schedule-script/script-log.ts";

describe("secretMasker", () => {
  const mask = secretMasker(["xoxp-1234-secret", "tk_abc/def", "abc", 42]);

  it("hides a secret however it was printed: raw, in a URL, in a JSON string", () => {
    expect(mask("token xoxp-1234-secret used")).toBe(`token ${SECRET_MASK} used`);
    expect(mask("https://x?t=tk_abc%2Fdef")).toBe(`https://x?t=${SECRET_MASK}`);
    expect(mask(JSON.stringify({ t: 'say "xoxp-1234-secret"' }))).not.toContain("xoxp-1234-secret");
  });

  it("leaves very short values and non-strings alone", () => {
    expect(mask("abc 42")).toBe("abc 42");
    expect(secretMasker([])("anything")).toBe("anything");
  });

  it("masks the start of a secret a cut left at the end, in any of its forms, only when told the text was cut", () => {
    expect(mask("token xoxp-12", true)).toBe(`token ${SECRET_MASK}`);
    expect(mask("token xoxp-12")).toBe("token xoxp-12");
    expect(mask("https://x?t=tk_abc%2F", true)).toBe(`https://x?t=${SECRET_MASK}`);
    expect(mask("nothing secret here", true)).toBe("nothing secret here");
  });

  it("masks the longest such end, whichever secret it starts", () => {
    expect(secretMasker(["f-long-secret-1", "abcdefgh"])("id abcdef", true)).toBe(`id ${SECRET_MASK}`);
  });
});

describe("RunLog", () => {
  it("masks before it cuts, so a cut line never shows half a secret", () => {
    const secret = "S".repeat(10);
    const ring = new LogRing();
    const log = new RunLog(ring, secretMasker([secret]));
    log.push("x".repeat(MAX_LINE_CHARS - 5) + secret);
    const [line] = ring.since(0);
    expect(line!.text).not.toContain("SSSSS");
    expect(line!.text.endsWith(SECRET_MASK)).toBe(true);
    expect(log.lines).toBe(1);
  });

  it("cuts a line longer than 4096 characters and says so", () => {
    const ring = new LogRing();
    const log = new RunLog(ring, (t) => t);
    log.push("y".repeat(MAX_LINE_CHARS + 100));
    expect(ring.since(0)[0]!.text).toBe(`${"y".repeat(MAX_LINE_CHARS)} … [line cut]`);
    expect(log.output.toString()).toContain("[line cut]");
  });
});

describe("LogRing", () => {
  it("keeps the last 1000 lines, and hands out the ones after a sequence number", () => {
    const ring = new LogRing();
    for (let i = 1; i <= 1005; i++) ring.push(`l${i}`);
    const all = ring.since(0);
    expect(all).toHaveLength(1000);
    expect(all[0]!.text).toBe("l6");
    expect(ring.since(1003).map((l) => l.text)).toEqual(["l1004", "l1005"]);
  });
});

/** A byte stream the test writes to while `readLines` reads it. */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    stream,
    write: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
    /** Resolves once the reader has taken and handled every chunk written so far. */
    taken: async () => {
      for (let i = 0; i < 500 && (controller.desiredSize ?? 0) < 1; i++) await Bun.sleep(2);
      await Bun.sleep(0);
    },
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const out = openStream();
  out.write(text);
  out.end();
  return out.stream;
}

describe("readLines", () => {
  it("joins lines split across chunks, even mid-character, and keeps a last line with no newline", async () => {
    const bytes = new TextEncoder().encode("một\r\nhai\nba");
    const chunks = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)];
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const lines: string[] = [];
    await readLines(stream, (l) => lines.push(l));
    expect(lines).toEqual(["một", "hai", "ba"]);
  });

  it("passes a line on, cut, once it is too long, and holds none of the rest while waiting for its newline", async () => {
    const out = openStream();
    const lines: [string, boolean][] = [];
    const done = readLines(out.stream, (line, cut) => lines.push([line, cut]));
    const megabyte = "A".repeat(1024 * 1024);
    Bun.gc(true);
    const heapBefore = heapStats().heapSize;
    for (let i = 0; i < 64; i++) out.write(megabyte);
    await out.taken();
    expect(lines.map(([line, cut]) => [line.length, cut, line.replaceAll("A", "")])).toEqual([[MAX_READ_LINE_CHARS, true, ""]]);
    Bun.gc(true);
    expect(heapStats().heapSize - heapBefore).toBeLessThan(16 * 1024 * 1024);

    out.write(`${"B".repeat(1024 * 1024)}\nnext\n`);
    out.end();
    await done;
    expect(lines.slice(1)).toEqual([["next", false]]);
  });

  it("cuts a long line whose newline came with it, and keeps the lines around it whole", async () => {
    const lines: [string, boolean][] = [];
    await readLines(streamOf(`${"y".repeat(100)}\n${"x".repeat(150)}\nshort\n`), (line, cut) => lines.push([line, cut]), 100);
    expect(lines).toEqual([["y".repeat(100), false], ["x".repeat(100), true], ["short", false]]);
  });

  it("leaves no part of a secret the cut went through", async () => {
    const secret = "S3cret-Value-0123";
    const ring = new LogRing();
    const log = new RunLog(ring, secretMasker([secret]));
    await readLines(streamOf(`${"x".repeat(90)}${secret}\n`), (line, cut) => log.push(line, cut), 100);
    expect(ring.since(0).map((l) => l.text)).toEqual([`${"x".repeat(90)}${SECRET_MASK} … [line cut]`]);
  });
});
