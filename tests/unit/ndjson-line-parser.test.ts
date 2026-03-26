import { describe, test, expect } from "bun:test";
import { parseNdjsonLines } from "../../src/utils/ndjson-line-parser.ts";
import { Readable } from "node:stream";

describe("parseNdjsonLines", () => {
  test("parses complete JSON lines", async () => {
    const stream = Readable.from(['{"type":"text","content":"hello"}\n{"type":"done"}\n']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([
      { type: "text", content: "hello" },
      { type: "done" },
    ]);
  });

  test("handles split packets (partial lines)", async () => {
    const stream = Readable.from(['{"type":"te', 'xt","content":"hello"}\n']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ type: "text", content: "hello" }]);
  });

  test("skips empty lines", async () => {
    const stream = Readable.from(['\n\n{"type":"done"}\n\n']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ type: "done" }]);
  });

  test("skips non-JSON lines (stderr leaks)", async () => {
    const stream = Readable.from(['WARNING: deprecated\n{"type":"done"}\n']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ type: "done" }]);
  });

  test("handles trailing content without newline", async () => {
    const stream = Readable.from(['{"type":"done"}']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ type: "done" }]);
  });

  test("handles multiple chunks with split across boundaries", async () => {
    const stream = Readable.from([
      '{"a":1}\n{"b":',
      '2}\n{"c":3}\n',
    ]);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("handles empty stream", async () => {
    const stream = Readable.from([""]);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([]);
  });

  test("handles \\r\\n line endings", async () => {
    const stream = Readable.from(['{"type":"text"}\r\n{"type":"done"}\r\n']);
    const results: unknown[] = [];
    for await (const obj of parseNdjsonLines(stream)) results.push(obj);
    expect(results).toEqual([{ type: "text" }, { type: "done" }]);
  });
});
