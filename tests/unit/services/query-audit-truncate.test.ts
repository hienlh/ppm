import { describe, it, expect } from "bun:test";
import { truncateResult, capBytes, MAX_RESULT_BYTES } from "../../../src/services/query-audit/result-truncate.ts";

function makeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}` }));
}

describe("truncateResult", () => {
  it("returns nothing for empty or missing results", () => {
    for (const input of [null, undefined, []]) {
      const out = truncateResult(input as never);
      expect(out.head).toBeNull();
      expect(out.tail).toBeNull();
      expect(out.truncated).toBe(false);
      expect(out.bytes).toBe(0);
    }
  });

  it("keeps every row when the result is small", () => {
    const out = truncateResult(makeRows(3));
    expect(JSON.parse(out.head!)).toHaveLength(3);
    expect(out.tail).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("keeps every row at exactly the head+tail boundary", () => {
    const out = truncateResult(makeRows(10));
    expect(JSON.parse(out.head!)).toHaveLength(10);
    expect(out.tail).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("keeps first and last five rows once the middle is dropped", () => {
    const out = truncateResult(makeRows(1000));
    const head = JSON.parse(out.head!) as { id: number }[];
    const tail = JSON.parse(out.tail!) as { id: number }[];

    expect(head).toHaveLength(5);
    expect(tail).toHaveLength(5);
    expect(head[0]!.id).toBe(0);
    expect(tail[4]!.id).toBe(999);
    expect(out.truncated).toBe(true);
  });

  it("caps a single oversized row instead of storing it whole", () => {
    const out = truncateResult([{ blob: "x".repeat(1024 * 1024) }]);

    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("treats the byte budget as a total across head and tail, not per part", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, blob: "y".repeat(20_000) }));
    const out = truncateResult(rows);

    expect(out.head).not.toBeNull();
    expect(out.tail).not.toBeNull();
    expect(out.bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(out.truncated).toBe(true);
  });

  it("caps oversized statement text and params on insert", () => {
    const huge = "SELECT '" + "z".repeat(200_000) + "'";
    const out = capBytes(huge, MAX_RESULT_BYTES);

    expect(out.cut).toBe(true);
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("keeps the stored sample parseable when JSON serialization fails", () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;

    const out = truncateResult([circular]);
    expect(() => JSON.parse(out.head!)).not.toThrow();
    expect(out.head).toContain("_unserializable");
  });

  it("serializes BigInt values rather than throwing", () => {
    const out = truncateResult([{ big: BigInt(9007199254740993n) }]);
    expect(out.head).toContain("9007199254740993");
  });
});
