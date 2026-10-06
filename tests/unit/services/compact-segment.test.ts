import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonlTranscript } from "../../../src/services/jsonl-transcript-parser";
import { compactSegmentWindow, parseCompactSegment } from "../../../src/services/compact-segment";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ppm-compact-segment-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

// A message with no timestamp is stamped with the time it was parsed, which
// would make two parses of one file differ by a millisecond.
const T = "2026-10-04T00:00:00.000Z";
const user = (uuid: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ uuid, type: "user", message: { content }, timestamp: T, ...extra });
const assistant = (uuid: string, text: string) =>
  JSON.stringify({ uuid, type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: T });
const boundary = (uuid: string, preTokens: number) =>
  JSON.stringify({
    uuid, type: "system", subtype: "compact_boundary", parentUuid: null,
    compactMetadata: { trigger: "auto", preTokens, postTokens: 1000 },
  });
const attachment = (uuid: string, parentUuid: string) =>
  JSON.stringify({ uuid, parentUuid, type: "attachment", attachment: { type: "todo_reminder" } });
const summary = (uuid: string, parentUuid: string, text: string) =>
  user(uuid, `${text} — read the full transcript at: /x.jsonl`, { parentUuid, isCompactSummary: true });

/** Writes the lines and answers the byte offset each one starts at, by uuid. */
function transcript(name: string, lines: string[], trailingNewline = true): { file: string; at: Map<string, number> } {
  const file = join(dir, name);
  writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  const at = new Map<string, number>();
  let offset = 0;
  for (const line of lines) {
    const uuid = (JSON.parse(line) as { uuid?: string }).uuid;
    if (uuid) at.set(uuid, offset);
    offset += Buffer.byteLength(line) + 1;
  }
  return { file, at };
}

/** Both compaction layouts Claude Code has written, plus a segment before any compaction. */
const SESSION = [
  user("a1", "oldest question"),
  assistant("a2", "oldest answer"),
  // Current layout: the summary hangs off the last of three attachments.
  boundary("b1", 50_000),
  attachment("x1", "b1"),
  attachment("x2", "x1"),
  attachment("x3", "x2"),
  summary("s1", "x3", "summary one"),
  user("m1", "middle question"),
  // Older layout: the summary is the boundary's own child, so it carries figures.
  boundary("b2", 90_000),
  summary("s2", "b2", "summary two"),
  assistant("m2", "middle answer"),
  boundary("b3", 120_000),
  summary("s3", "b3", "summary three"),
  user("n1", "newest question"),
];

describe("parseCompactSegment", () => {
  test("answers exactly what the full parse answers, wherever the segment is", async () => {
    const { file } = transcript("parity.jsonl", SESSION);
    for (const before of ["s1", "s2", "s3", undefined, "not-a-uuid-in-this-file"]) {
      expect(await parseCompactSegment(file, before))
        .toEqual(await parseJsonlTranscript(file, before, { oneSegment: true }));
    }
  });

  test("keeps the figures of the segment's own compaction", async () => {
    // The boundary carrying them sits ahead of the summary, so a window opened
    // at the summary would parse the right messages and silently drop the
    // divider's "saved N tokens".
    const { file } = transcript("figures.jsonl", SESSION);
    const segment = await parseCompactSegment(file, "s3");
    expect(segment.map((m) => m.id)).toEqual(["s2", "m2"]);
    expect(segment[0]!.compaction).toMatchObject({ preTokens: 90_000, savedTokens: 89_000 });
  });

  test("bounds the segment it reads, not the file it reads from", async () => {
    const filler = "x".repeat(200_000);
    const { file } = transcript("bound.jsonl", [
      user("old", filler),
      boundary("b1", 50_000), summary("s1", "b1", "one"),
      user("mid", "small"),
      boundary("b2", 50_000), summary("s2", "b2", "two"),
      user("new", "small"),
      boundary("b3", 50_000), summary("s3", "b3", "three"),
    ]);
    // The file is over the bound; the newest segment is far under it.
    expect((await parseCompactSegment(file, "s3", 100_000)).map((m) => m.id)).toEqual(["s2", "new"]);
    // The oldest one is not, and is refused in the words the route maps to 403.
    await expect(parseCompactSegment(file, "s1", 100_000)).rejects.toThrow(/too large/);
  });
});

describe("compactSegmentWindow", () => {
  test("opens at the summary before the segment's own and ends where `before` starts", async () => {
    const { file, at } = transcript("window.jsonl", SESSION);
    expect(await compactSegmentWindow(file, "s3")).toEqual({ fromByte: at.get("s1")!, toByte: at.get("s3")! });
    // With one summary ahead there is nothing earlier to open at.
    expect(await compactSegmentWindow(file, "s2")).toEqual({ fromByte: 0, toByte: at.get("s2")! });
    // A uuid the file does not hold reads to the end, as the full parse does.
    expect(await compactSegmentWindow(file, "missing")).toEqual({ fromByte: at.get("s2")!, toByte: undefined });
    expect(await compactSegmentWindow(file)).toEqual({ fromByte: at.get("s2")!, toByte: undefined });
  });

  test("a marker inside another record moves nothing", async () => {
    // Only a top-level field is the record's own. A tool result that carries the
    // same text as an object — not as an escaped string — matches as bytes.
    const decoy = JSON.stringify({
      uuid: "decoy", type: "user", message: { content: "tool output" }, timestamp: T,
      toolUseResult: { uuid: "s3", isCompactSummary: true },
    });
    const lines = [...SESSION.slice(0, 11), decoy, ...SESSION.slice(11)];
    const { file, at } = transcript("decoy.jsonl", lines);
    expect(await compactSegmentWindow(file, "s3")).toEqual({ fromByte: at.get("s1")!, toByte: at.get("s3")! });
    expect(await parseCompactSegment(file, "s3")).toEqual(await parseJsonlTranscript(file, "s3", { oneSegment: true }));
  });

  test("offsets stay byte-exact across records longer than a read chunk", async () => {
    // Bun reads a file in 256KB chunks; a 1.2MB summary of multi-byte text spans
    // several, with characters split across their edges.
    const long = "Tiếng Việt có dấu — 日本語 — 🎉 ".repeat(40_000);
    const lines = SESSION.map((line) => (line === SESSION[9] ? summary("s2", "b2", long) : line));
    const { file, at } = transcript("long.jsonl", lines);
    expect(await compactSegmentWindow(file, "s3")).toEqual({ fromByte: at.get("s1")!, toByte: at.get("s3")! });
    const segment = await parseCompactSegment(file, "s3");
    expect(segment).toEqual(await parseJsonlTranscript(file, "s3", { oneSegment: true }));
    expect(segment[0]!.content.startsWith(long)).toBe(true);
  });

  test("a window that ends megabytes before the end of the file finishes", async () => {
    // Each scroll up reaches an older segment, whose read ends further from EOF
    // — the case where Bun 1.3.11's `slice(a, b).stream()` never finished, and
    // why `readLines` counts to `toByte` itself.
    const later = Array.from({ length: 40 }, (_, i) => user(`later${i}`, "y".repeat(100_000)));
    const { file } = transcript("far-from-eof.jsonl", [...SESSION, ...later]);
    expect((await parseCompactSegment(file, "s2")).map((m) => m.id)).toEqual(["s1", "m1"]);
    expect(await parseCompactSegment(file, "s2")).toEqual(await parseJsonlTranscript(file, "s2", { oneSegment: true }));
  });

  test.skipIf(process.platform !== "linux")("leaves no file open behind it", async () => {
    // Every read here stops before the end of the file, and a stream let go of
    // early keeps its descriptor: three per expand, for as long as PPM runs.
    const later = Array.from({ length: 40 }, (_, i) => user(`later${i}`, "y".repeat(100_000)));
    const { file } = transcript("descriptors.jsonl", [...SESSION, ...later]);
    const open = () => readdirSync("/proc/self/fd").length;
    const before = open();
    for (let i = 0; i < 50; i++) await parseCompactSegment(file, "s2");
    expect(open() - before).toBeLessThan(10);
  });

  test("finds `before` on a last line that has no newline yet", async () => {
    const lines = SESSION.slice(0, 13); // ends on s3
    const { file, at } = transcript("unterminated.jsonl", lines, false);
    expect(await compactSegmentWindow(file, "s3")).toEqual({ fromByte: at.get("s1")!, toByte: at.get("s3")! });
    expect(await parseCompactSegment(file, "s3")).toEqual(await parseJsonlTranscript(file, "s3", { oneSegment: true }));
  });
});
