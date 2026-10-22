import { describe, it, expect } from "bun:test";
import { secretMasker, SECRET_MASK } from "../../../../src/services/schedule-script/secret-mask.ts";
import { LogRing, MAX_LINE_CHARS, RunLog, readLines } from "../../../../src/services/schedule-script/script-log.ts";

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

describe("readLines", () => {
  it("joins lines split across chunks, even mid-character, and keeps a last line with no newline", async () => {
    const bytes = new TextEncoder().encode("một\r\nhai\nba");
    const chunks = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)];
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const lines: string[] = [];
    await readLines(stream, (l) => lines.push(l));
    expect(lines).toEqual(["một", "hai", "ba"]);
  });
});
