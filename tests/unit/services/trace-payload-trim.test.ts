import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { readEvents } from "../../../src/services/session-trace/session-trace-store.ts";
import { traceStream } from "../../../src/services/session-trace/trace-recorder.ts";
import { TRACE_TEXT_LIMIT, trimTracePayload, trimTraceText } from "../../../src/services/session-trace/trace-payload-trim.ts";

/** Text whose head and tail are recognisable, so a test can tell which parts were kept. */
function longText(length: number): string {
  const middle = "m".repeat(length - 8);
  return `HEAD${middle}TAIL`;
}

describe("trimTraceText", () => {
  it("keeps text at the limit whole", () => {
    const text = "x".repeat(TRACE_TEXT_LIMIT);
    expect(trimTraceText(text)).toBe(text);
  });

  it("keeps the first and last 4 KB around a marker naming what was cut", () => {
    const text = longText(20_000);
    const out = trimTraceText(text);
    expect(out.startsWith(`HEAD${"m".repeat(4092)}\n…[trimmed 11808 of 20000 chars]…\n`)).toBe(true);
    expect(out.endsWith(`${"m".repeat(4092)}TAIL`)).toBe(true);
    expect(out.length).toBe(8192 + "\n…[trimmed 11808 of 20000 chars]…\n".length);
  });

  it("never splits an emoji at either cut", () => {
    const emoji = "\u{1F600}"; // two UTF-16 code units
    // Head: the pair straddles index 4095/4096. Tail: it straddles the first index the tail keeps.
    const text = "a".repeat(4095) + emoji + "b".repeat(6000) + emoji + "c".repeat(4095);
    const out = trimTraceText(text);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.startsWith(`${"a".repeat(4095)}\n`)).toBe(true);
    expect(out.endsWith(emoji + "c".repeat(4095))).toBe(true);
  });
});

describe("trimTracePayload", () => {
  it("returns a small tool_result as the same object, so its row is byte-identical", () => {
    const payload = { type: "tool_result", output: "ok", toolUseId: "t1", isError: false };
    expect(trimTracePayload(payload)).toBe(payload);
  });

  it("trims a large tool_result and records its original length", () => {
    const output = longText(50_000);
    const payload = { type: "tool_result", output, toolUseId: "t1" };
    const out = trimTracePayload(payload) as Record<string, unknown>;
    expect(out).toMatchObject({ type: "tool_result", toolUseId: "t1", outputLength: 50_000, trimmed: true });
    expect(out.output).toBe(trimTraceText(output));
    // The live event is observed, never altered.
    expect(payload.output).toBe(output);
  });

  it("keeps a large error result whole", () => {
    const payload = { type: "tool_result", output: longText(50_000), isError: true };
    expect(trimTracePayload(payload)).toBe(payload);
  });

  it("leaves a tool_result whose output is not a string alone", () => {
    const payload = { type: "tool_result", output: [{ type: "text", text: longText(50_000) }] };
    expect(trimTracePayload(payload)).toBe(payload);
  });

  it("returns a tool_use with no long strings as the same object", () => {
    const payload = { type: "tool_use", tool: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b" }, toolUseId: "u1" };
    expect(trimTracePayload(payload)).toBe(payload);
  });

  it("trims each long string in a tool_use input, nested ones too, and records each length", () => {
    const content = longText(30_000);
    const oldString = longText(9_000);
    const payload = {
      type: "tool_use",
      tool: "MultiEdit",
      toolUseId: "u1",
      input: { file_path: "/a.ts", content, edits: [{ old_string: oldString, new_string: "short" }] },
    };
    const out = trimTracePayload(payload) as { input: any; inputLengths: Record<string, number>; trimmed: boolean };
    expect(out.trimmed).toBe(true);
    expect(out.inputLengths).toEqual({ content: 30_000, "edits.0.old_string": 9_000 });
    expect(out.input.file_path).toBe("/a.ts");
    expect(out.input.content).toBe(trimTraceText(content));
    expect(out.input.edits[0]).toEqual({ old_string: trimTraceText(oldString), new_string: "short" });
    // The original input is untouched.
    expect(payload.input.content).toBe(content);
    expect(payload.input.edits[0]!.old_string).toBe(oldString);
  });

  it("trims a tool_use whose whole input is one long string", () => {
    const input = longText(10_000);
    const out = trimTracePayload({ type: "tool_use", tool: "Bash", input }) as Record<string, unknown>;
    expect(out).toMatchObject({ input: trimTraceText(input), inputLengths: { input: 10_000 }, trimmed: true });
  });

  it("leaves every other event type alone, however long", () => {
    const text = { type: "text", content: longText(50_000) };
    const user = { type: "user_message", text: longText(50_000) };
    expect(trimTracePayload(text)).toBe(text);
    expect(trimTracePayload(user)).toBe(user);
    expect(trimTracePayload(null)).toBe(null);
    expect(trimTracePayload("raw")).toBe("raw");
  });
});

describe("recording a run", () => {
  const originalHome = process.env.PPM_HOME;
  let home = "";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ppm-trace-trim-"));
    process.env.PPM_HOME = home;
    closeTraceDb();
    _resetPpmDir();
  });

  afterAll(() => {
    closeTraceDb();
    process.env.PPM_HOME = originalHome;
    _resetPpmDir();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  });

  it("stores long tool output trimmed and leaves the stream it observed untouched", async () => {
    const big = longText(40_000);
    const events = [
      { type: "tool_use", tool: "Write", input: { file_path: "/a.ts", content: big }, toolUseId: "u1" },
      { type: "tool_result", output: big, toolUseId: "u1" },
      { type: "tool_result", output: big, toolUseId: "u2", isError: true },
      { type: "tool_result", output: "small", toolUseId: "u3" },
      { type: "done", sessionId: "trim-run" },
    ];
    async function* source() { for (const e of events) yield e; }

    const seen: unknown[] = [];
    for await (const e of traceStream({ sessionId: "trim-run", providerId: "test", message: "go" }, source())) seen.push(e);
    expect(seen).toEqual(events);
    expect((events[1] as { output: string }).output).toBe(big);

    const rows = readEvents("trim-run").filter((r) => r.type === "tool_use" || r.type === "tool_result");
    const payloads = rows.map((r) => r.payload as Record<string, any>);
    expect(payloads[0]!.input.content).toBe(trimTraceText(big));
    expect(payloads[0]!.inputLengths).toEqual({ content: 40_000 });
    expect(payloads[1]).toMatchObject({ output: trimTraceText(big), outputLength: 40_000, trimmed: true });
    expect(payloads[2]!.output).toBe(big);
    expect(payloads[3]).toEqual({ type: "tool_result", output: "small", toolUseId: "u3" });
  });
});
