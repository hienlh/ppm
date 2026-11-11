import { describe, expect, test } from "bun:test";
import { buildSearchMatch, parseRgJsonLine } from "../../../../src/services/content-search/rg-json-parse";
import { PREVIEW_AFTER, PREVIEW_BEFORE } from "../../../../src/services/content-search/search-options";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

/** A `match` event as rg 15 prints it with `--json`. */
function matchEvent(opts: {
  path?: unknown;
  lines: unknown;
  line?: number;
  submatches: Array<{ start: number; end: number; text?: string; replacement?: unknown }>;
}): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: opts.path ?? { text: "./a.txt" },
      lines: opts.lines,
      line_number: opts.line ?? 1,
      absolute_offset: 0,
      submatches: opts.submatches.map((s) => ({
        match: { text: s.text ?? "" },
        ...(s.replacement !== undefined ? { replacement: s.replacement } : {}),
        start: s.start,
        end: s.end,
      })),
    },
  });
}

describe("parseRgJsonLine", () => {
  test("events other than match answer null", () => {
    expect(parseRgJsonLine('{"type":"begin","data":{"path":{"text":"./a.txt"}}}')).toBeNull();
    expect(parseRgJsonLine('{"type":"end","data":{"path":{"text":"./a.txt"},"binary_offset":null,"stats":{}}}')).toBeNull();
    expect(parseRgJsonLine('{"data":{"stats":{}},"type":"summary"}')).toBeNull();
    expect(parseRgJsonLine("")).toBeNull();
  });

  test("one match per submatch, each with its own column range, the path without ./", () => {
    // Exactly what rg 15.2 printed for `rg --json -r 'X$0' foo .`
    const line =
      '{"type":"match","data":{"path":{"text":"./a.txt"},"lines":{"text":"café foo 😀 foo\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"foo"},"replacement":{"text":"Xfoo"},"start":6,"end":9},{"match":{"text":"foo"},"replacement":{"text":"Xfoo"},"start":15,"end":18}]}}';
    const parsed = parseRgJsonLine(line);
    expect(parsed?.file).toBe("a.txt");
    expect(parsed?.matches).toHaveLength(2);
    const [first, second] = parsed!.matches;
    // "é" is 2 bytes / 1 UTF-16 unit; "😀" is 4 bytes / 2 UTF-16 units.
    expect(first.line).toBe(1);
    expect(first.column).toBe(5);
    expect(first.length).toBe(3);
    expect(first.text).toBe("foo");
    expect(first.replacement).toBe("Xfoo");
    expect(second.column).toBe(12); // "café foo " is 9 units, "😀" 2, then a space
    expect(second.text).toBe("foo");
    expect("café foo 😀 foo".slice(second.column, second.column + second.length)).toBe("foo");
    // The line terminator never reaches the preview.
    expect(second.after).toBe("");
    expect(first.after).toBe(" 😀 foo");
    expect(first.before).toBe("café ");
    expect(first.cutBefore).toBe(false);
  });

  test("no replacement field when rg ran without -r", () => {
    const parsed = parseRgJsonLine(
      matchEvent({ lines: { text: "a foo b\n" }, line: 7, submatches: [{ start: 2, end: 5, text: "foo" }] }),
    );
    expect(parsed!.matches[0].line).toBe(7);
    expect(parsed!.matches[0]).not.toHaveProperty("replacement");
  });

  test("an empty replacement is kept, not dropped", () => {
    const parsed = parseRgJsonLine(
      matchEvent({ lines: { text: "a foo\n" }, submatches: [{ start: 2, end: 5, replacement: { text: "" } }] }),
    );
    expect(parsed!.matches[0].replacement).toBe("");
  });

  test("a line that is not UTF-8 (lines.bytes) is decoded lossily, columns still in UTF-16", () => {
    // "caf\xe9 foo\n" in Latin-1: rg prints it as bytes.
    const parsed = parseRgJsonLine(
      matchEvent({
        path: { text: "c.txt" },
        lines: { bytes: b64([0x63, 0x61, 0x66, 0xe9, 0x20, 0x66, 0x6f, 0x6f, 0x0a]) },
        submatches: [{ start: 5, end: 8, text: "foo", replacement: { text: "Y" } }],
      }),
    );
    expect(parsed!.file).toBe("c.txt");
    const m = parsed!.matches[0];
    expect(m.text).toBe("foo");
    expect(m.column).toBe(5);
    expect(m.before).toBe("caf� ");
    expect(m.replacement).toBe("Y");
  });

  test("a path and a replacement given as bytes are decoded", () => {
    const parsed = parseRgJsonLine(
      matchEvent({
        path: { bytes: b64([...Buffer.from("./dir/"), 0xff, ...Buffer.from(".txt")]) },
        lines: { text: "foo\n" },
        submatches: [{ start: 0, end: 3, replacement: { bytes: b64([0x41, 0xff]) } }],
      }),
    );
    expect(parsed!.file).toBe("dir/�.txt");
    expect(parsed!.matches[0].replacement).toBe("A�");
  });

  test("a match far into a long line keeps the match visible and marks the cut", () => {
    const head = "x".repeat(1000);
    const tail = "y".repeat(1000);
    const text = `${head}NEEDLE${tail}`;
    const parsed = parseRgJsonLine(
      matchEvent({ lines: { text: `${text}\n` }, submatches: [{ start: 1000, end: 1006 }] }),
    );
    const m = parsed!.matches[0];
    expect(m.column).toBe(1000);
    expect(m.text).toBe("NEEDLE");
    expect(m.cutBefore).toBe(true);
    expect(m.before).toBe("x".repeat(PREVIEW_BEFORE));
    expect(m.after).toBe("y".repeat(PREVIEW_AFTER));
  });
});

describe("buildSearchMatch", () => {
  test("leading whitespace of the preview is trimmed, the column is not", () => {
    const m = buildSearchMatch("        return foo;", 3, 15, 18);
    expect(m).toEqual({ line: 3, column: 15, length: 3, before: "return ", cutBefore: false, text: "foo", after: ";" });
  });

  test("the cut never splits a surrogate pair", () => {
    // 30 emoji (60 units) then the match: a cut at 26 units back lands on a pair boundary.
    const before = "😀".repeat(30);
    const line = `${before}a${"z"}`;
    const col = before.length + 1; // match "z", the cut 26 units back is mid-pair after the "a"
    const m = buildSearchMatch(line, 1, col, col + 1);
    expect(m.cutBefore).toBe(true);
    expect(m.before.length).toBeLessThanOrEqual(PREVIEW_BEFORE);
    expect(/^[\uDC00-\uDFFF]/.test(m.before)).toBe(false);
    expect(m.before.endsWith("😀a")).toBe(true);

    const after = "😀".repeat(PREVIEW_AFTER);
    // "a" + emoji: the PREVIEW_AFTER-th unit is a high surrogate.
    const m2 = buildSearchMatch(`za${after}`, 1, 0, 1);
    expect(m2.after.length).toBeLessThanOrEqual(PREVIEW_AFTER);
    expect(m2.after.startsWith("a😀")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(m2.after)).toBe(false);
  });

  test("a replacement is set only when given", () => {
    expect(buildSearchMatch("foo", 1, 0, 3, "bar").replacement).toBe("bar");
    expect(buildSearchMatch("foo", 1, 0, 3)).not.toHaveProperty("replacement");
  });
});
