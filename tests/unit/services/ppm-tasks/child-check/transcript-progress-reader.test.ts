import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRecordLines, codexRecordLines, judgeProgress, MAX_READ_BYTES, readAppended,
} from "../../../../../src/services/ppm-tasks/child-check/transcript-progress-reader.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-progress-"));
  file = join(dir, "s.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (iso: string) => Date.parse(iso);
const rec = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const assistantText = (text: string, ts: string) => rec({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });

describe("claudeRecordLines", () => {
  it("takes assistant text, tool names with their input's first line, and tool results", () => {
    expect(claudeRecordLines({ type: "assistant", message: { content: [
      { type: "text", text: "Checking\nagain" },
      { type: "tool_use", name: "Bash", input: { command: "bun test\n--watch" } },
      { type: "thinking", thinking: "secret plan" },
    ] } })).toEqual({ lines: [{ text: "Checking", quotable: true }, { text: "again", quotable: true }, { text: "Bash bun test", quotable: true }], unknown: false });
    const many = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const result = claudeRecordLines({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: many }] }] } }).lines;
    expect(result).toHaveLength(20);
    // Tool output is what the child read: never quoted to the manager.
    expect(result.every((l) => !l.quotable)).toBe(true);
  });

  it("skips the user's own words and bookkeeping records", () => {
    expect(claudeRecordLines({ type: "user", message: { content: "please do it" } }).lines).toEqual([]);
    expect(claudeRecordLines({ type: "user", message: { content: [{ type: "text", text: "nudge" }] } }).lines).toEqual([]);
    expect(claudeRecordLines({ type: "api-request", message: { content: [{ type: "weird" }] } })).toEqual({ lines: [], unknown: false });
    expect(claudeRecordLines({ type: "ai-title", title: "x" })).toEqual({ lines: [], unknown: false });
  });

  it("flags an unknown content block (counts as progress)", () => {
    expect(claudeRecordLines({ type: "assistant", message: { content: [{ type: "hologram" }] } }).unknown).toBe(true);
  });
});

describe("codexRecordLines", () => {
  it("reads agent messages, calls and their output", () => {
    const texts = (r: Record<string, unknown>) => codexRecordLines(r).lines.map((l) => l.text);
    expect(texts({ type: "event_msg", payload: { type: "agent_message", message: "done step" } })).toEqual(["done step"]);
    expect(texts({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}" } })).toEqual(["shell {\"cmd\":\"ls\"}"]);
    expect(codexRecordLines({ type: "response_item", payload: { type: "function_call_output", output: "a\nb" } }).lines).toEqual([{ text: "a", quotable: false }, { text: "b", quotable: false }]);
    expect(codexRecordLines({ type: "event_msg", payload: { type: "token_count" } })).toEqual({ lines: [], unknown: false });
    expect(codexRecordLines({ type: "response_item", payload: { type: "brand_new" } }).unknown).toBe(true);
  });
});

describe("readAppended", () => {
  it("reads only what was appended since the offset, complete lines only", () => {
    writeFileSync(file, assistantText("one", "2026-01-01T00:00:00Z"));
    const first = readAppended(file, 0, "claude", 0)!;
    expect(first.lines.map((l) => l.text)).toEqual(["one"]);
    appendFileSync(file, assistantText("two", "2026-01-01T00:01:00Z") + '{"type":"assistant","partial');
    const second = readAppended(file, first.offset, "claude", 0)!;
    expect(second.lines.map((l) => l.text)).toEqual(["two"]);
    expect(second.lines[0]!.at).toBe(at("2026-01-01T00:01:00Z"));
    // The partial record is read once it is complete.
    appendFileSync(file, '"}\n');
    expect(readAppended(file, second.offset, "claude", 0)!.lines).toEqual([]);
  });

  it("leaves out records from before the hand-off", () => {
    writeFileSync(file, assistantText("old", "2026-01-01T00:00:00Z") + assistantText("new", "2026-01-01T02:00:00Z"));
    expect(readAppended(file, 0, "claude", at("2026-01-01T01:00:00Z"))!.lines.map((l) => l.text)).toEqual(["new"]);
  });

  it("reads at most 256 KB, keeping the tail, so a 10 MB file is not read whole", () => {
    const filler = assistantText("x".repeat(1000), "2026-01-01T00:00:00Z");
    writeFileSync(file, filler.repeat(Math.ceil((10 * 1024 * 1024) / filler.length)) + assistantText("tail line", "2026-01-01T00:00:01Z"));
    const read = readAppended(file, 0, "claude", 0)!;
    expect(read.lines.at(-1)!.text).toBe("tail line");
    expect(read.lines.length).toBeLessThanOrEqual(Math.ceil(MAX_READ_BYTES / filler.length) * 40);
  });

  it("starts over when the file shrank, and answers null for a missing file", () => {
    writeFileSync(file, assistantText("a", "2026-01-01T00:00:00Z").repeat(5));
    const big = readAppended(file, 0, "claude", 0)!;
    writeFileSync(file, assistantText("b", "2026-01-01T00:00:00Z"));
    expect(readAppended(file, big.offset, "claude", 0)!.lines.map((l) => l.text)).toEqual(["b"]);
    expect(readAppended(join(dir, "nope.jsonl"), 0, "claude", 0)).toBeNull();
  });
});

describe("judgeProgress", () => {
  const N = 30 * 60_000;
  it("counts a new form as progress and a repeat as none", () => {
    const t0 = 1_000_000;
    const first = judgeProgress([{ text: "memory 86% waiting", at: t0, quotable: false }], [], t0, 3 * N);
    expect(first.progressAt).toBe(t0);
    const again = judgeProgress([{ text: "memory 87% waiting", at: t0 + 5 * 60_000, quotable: false }], first.recent, t0 + 5 * 60_000, 3 * N);
    expect(again.progressAt).toBeNull();
  });

  it("treats a form last seen more than 3 intervals before the line as new again", () => {
    const t0 = 1_000_000;
    const first = judgeProgress([{ text: "ping", at: t0, quotable: true }], [], t0, 3 * N);
    expect(judgeProgress([{ text: "ping", at: t0 + 3 * N, quotable: true }], first.recent, t0 + 3 * N, 3 * N).progressAt).toBe(t0 + 3 * N);
  });

  it("keeps at most 64 forms", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ text: `step ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, at: i, quotable: true }));
    expect(judgeProgress(lines, [], 100, 3 * N).recent).toHaveLength(64);
  });
});
