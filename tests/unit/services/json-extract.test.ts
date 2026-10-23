import { describe, expect, it } from "bun:test";
import { extractJson } from "../../../src/services/extension-ai/json-extract.ts";

describe("extractJson", () => {
  it("parses a bare JSON answer", () => {
    expect(extractJson('{"a":1}')).toEqual({ found: true, value: { a: 1 } });
    expect(extractJson("  [1,2]\n")).toEqual({ found: true, value: [1, 2] });
  });

  it("finds JSON inside a code fence or a sentence", () => {
    expect(extractJson('Here it is:\n```json\n{"same": true, "score": 0.9}\n```\nDone.')).toEqual({ found: true, value: { same: true, score: 0.9 } });
  });

  it("respects braces and brackets inside strings", () => {
    expect(extractJson('Kết quả: {"reason_vi": "dấu } và ] trong chuỗi \\" ngoặc", "n": [1]} xong')).toEqual({
      found: true, value: { reason_vi: "dấu } và ] trong chuỗi \" ngoặc", n: [1] },
    });
  });

  it("skips a citation like [1] when the schema wants an object", () => {
    const text = 'Theo nguồn [1], câu trả lời là {"match_id": null, "score": 0.2}';
    expect(extractJson(text, "object")).toEqual({ found: true, value: { match_id: null, score: 0.2 } });
    expect(extractJson(text)).toEqual({ found: true, value: [1] });
  });

  it("falls back to the first JSON of another kind, and reports nothing when there is none", () => {
    expect(extractJson("xx [1, 2] yy", "object")).toEqual({ found: true, value: [1, 2] });
    expect(extractJson("no json here { not json }")).toEqual({ found: false });
    expect(extractJson('{"open": ')).toEqual({ found: false });
  });

  it("gives up quickly on a pathological answer", () => {
    const started = performance.now();
    expect(extractJson("{".repeat(200_000))).toEqual({ found: false });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
