import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  extractText,
  stripTeammateXml,
  parseSessionMessage,
  nestChildEvents,
  validateJsonlPath,
  parseJsonlTranscript,
} from "../../../src/services/jsonl-transcript-parser";
import type { ChatEvent } from "../../../src/types/chat";

// Place transcripts under real ~/.claude/ so validator prefix check passes
const CLAUDE_DIR = resolve(homedir(), ".claude");
const TEST_DIR = resolve(CLAUDE_DIR, "_ppm_test_transcripts");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("stripTeammateXml", () => {
  test("removes teammate-message tags", () => {
    const input = "Before<teammate-message name='x'>hi</teammate-message>after";
    expect(stripTeammateXml(input)).toBe("Beforeafter");
  });
  test("returns input unchanged when no tags", () => {
    expect(stripTeammateXml("plain text")).toBe("plain text");
  });
});

describe("extractText", () => {
  test("extracts string content", () => {
    expect(extractText({ content: "hello" })).toBe("hello");
  });
  test("joins text blocks from array content", () => {
    expect(extractText({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] })).toBe("ab");
  });
  test("returns empty on invalid", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
  });
});

describe("parseSessionMessage", () => {
  test("parses assistant text + tool_use", () => {
    const msg = parseSessionMessage({
      uuid: "u1", type: "assistant",
      message: { content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
      ] },
    });
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("hi");
    expect(msg.events?.length).toBe(2);
    expect(msg.events?.[1]).toMatchObject({ type: "tool_use", tool: "Read", toolUseId: "t1" });
  });

  test("clears user content when only tool_results", () => {
    const msg = parseSessionMessage({
      uuid: "u2", type: "user",
      message: { content: [{ type: "tool_result", content: "output", tool_use_id: "t1" }] },
    });
    expect(msg.content).toBe("");
    expect(msg.events?.[0]).toMatchObject({ type: "tool_result", output: "output" });
  });

  test("drops synthetic SDK error messages", () => {
    const msg = parseSessionMessage({
      uuid: "u3", type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate" }] },
      isApiErrorMessage: true,
    } as any);
    expect(msg.content).toBe("");
    expect(msg.events).toBeUndefined();
  });
});

describe("nestChildEvents", () => {
  test("nests child events under Agent parent", () => {
    const events: ChatEvent[] = [
      { type: "tool_use", tool: "Agent", toolUseId: "p1", input: {} },
      { type: "text", content: "child", parentToolUseId: "p1" },
      { type: "text", content: "top" },
    ];
    nestChildEvents(events);
    expect(events.length).toBe(2);
    const parent = events[0] as any;
    expect(parent.children?.length).toBe(1);
    expect(parent.children[0].content).toBe("child");
  });

  test("no-op when no Agent/Task parents", () => {
    const events: ChatEvent[] = [{ type: "text", content: "x" }];
    nestChildEvents(events);
    expect(events.length).toBe(1);
  });
});

describe("validateJsonlPath", () => {
  test("rejects empty path", () => {
    expect(() => validateJsonlPath("")).toThrow(/required/);
  });

  test("rejects non-jsonl file", () => {
    expect(() => validateJsonlPath("/tmp/foo.txt")).toThrow(/\.jsonl file/);
  });

  test("rejects path outside ~/.claude/", () => {
    const outside = resolve(tmpdir(), "outside.jsonl");
    writeFileSync(outside, "{}\n");
    try {
      expect(() => validateJsonlPath(outside)).toThrow(/denied|traversal/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("accepts valid path under ~/.claude/", () => {
    const p = resolve(TEST_DIR, "ok.jsonl");
    writeFileSync(p, "{}\n");
    const result = validateJsonlPath(p);
    expect(result.endsWith("ok.jsonl")).toBe(true);
  });

  test("rejects missing file", () => {
    expect(() => validateJsonlPath(resolve(TEST_DIR, "nope.jsonl"))).toThrow(/not found/i);
  });

  test("rejects symlink escaping ~/.claude/", () => {
    const outside = resolve(tmpdir(), "ppm-escape-target.jsonl");
    writeFileSync(outside, "{}\n");
    const symlinkPath = resolve(TEST_DIR, "escape.jsonl");
    try {
      symlinkSync(outside, symlinkPath);
      expect(() => validateJsonlPath(symlinkPath)).toThrow(/denied|traversal/);
    } finally {
      rmSync(outside, { force: true });
      rmSync(symlinkPath, { force: true });
    }
  });
});

describe("parseJsonlTranscript", () => {
  test("parses user + assistant, skips summary/result lines, applies merge", async () => {
    const lines = [
      JSON.stringify({ type: "summary", summary: "x", leafUuid: "l1" }),
      JSON.stringify({ uuid: "u1", type: "user", message: { content: "hello" } }),
      JSON.stringify({
        uuid: "u2", type: "assistant",
        message: { content: [
          { type: "text", text: "resp" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ] },
      }),
      JSON.stringify({
        uuid: "u3", type: "user",
        message: { content: [{ type: "tool_result", content: "data", tool_use_id: "t1" }] },
      }),
      "", // empty line
      "malformed-json{", // malformed
    ].join("\n");
    const file = resolve(TEST_DIR, "transcript.jsonl");
    writeFileSync(file, lines);

    const messages = await parseJsonlTranscript(file);
    expect(messages.length).toBe(2); // user "hello", assistant (with merged tool_result)
    expect(messages[0]).toMatchObject({ role: "user", content: "hello" });
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    // text + tool_use + merged tool_result
    expect(assistant.events?.length).toBe(3);
    expect(assistant.events?.[2]?.type).toBe("tool_result");
  });
});
